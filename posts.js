// Ride the Wave — posts API (Vercel serverless function)
// GET  /api/posts            -> list all posts (newest first)
// POST /api/posts {action}   -> "login" | "create" | "update" | "delete" (password required)
import { put, list, del } from '@vercel/blob';
import crypto from 'node:crypto';

const MAX_IMAGES = 6;
const CATEGORIES = ['Macro', 'Stocks', 'Crypto', 'Other'];
const cat = (c) => (CATEGORIES.includes(c) ? c : 'Other');

function passwordOk(pw) {
  const real = process.env.ADMIN_PASSWORD || '';
  if (!real || typeof pw !== 'string') return false;
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

async function allPostBlobs() {
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: 'posts/', cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function loadPosts() {
  const blobs = await allPostBlobs();
  const posts = await Promise.all(
    blobs.map(async (b) => {
      try {
        const res = await fetch(b.url, { cache: 'no-store' });
        if (!res.ok) return null;
        const p = await res.json();
        p._blobUrl = b.url;
        return p;
      } catch {
        return null;
      }
    })
  );
  return posts.filter(Boolean).sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''));
}

async function loadAbout() {
  const r = await list({ prefix: 'site/about' });
  const b = r.blobs.sort((x, y) => new Date(y.uploadedAt) - new Date(x.uploadedAt))[0];
  if (!b) return { about: null, blobs: r.blobs };
  try {
    const res = await fetch(b.url, { cache: 'no-store' });
    return { about: res.ok ? await res.json() : null, blobs: r.blobs };
  } catch {
    return { about: null, blobs: r.blobs };
  }
}

async function saveImages(dataUrls, id) {
  const urls = [];
  for (const [i, d] of (dataUrls || []).entries()) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(d || '');
    if (!m) continue;
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const blob = await put(`images/${id}-${i}.${ext}`, Buffer.from(m[3], 'base64'), {
      access: 'public',
      contentType: m[1],
      addRandomSuffix: true,
    });
    urls.push(blob.url);
  }
  return urls;
}

function clean(s, max) {
  return String(s || '').slice(0, max).trim();
}

async function writePost(post) {
  return put(`posts/${post.id}.json`, JSON.stringify(post), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: true,
    cacheControlMaxAge: 60,
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && req.query && 'about' in req.query) {
      const { about } = await loadAbout();
      return res.status(200).json(about || {});
    }
    if (req.method === 'GET') {
      const posts = await loadPosts();
      return res.status(200).json(posts.map(({ _blobUrl, ...p }) => p));
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (!passwordOk(body.password)) return res.status(401).json({ error: 'Wrong password' });

    if (body.action === 'login') return res.status(200).json({ ok: true });

    if (body.action === 'saveAbout') {
      const { blobs } = await loadAbout();
      const about = { content: clean(body.content, 20000), updatedAt: new Date().toISOString() };
      await put('site/about.json', JSON.stringify(about), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: true,
        cacheControlMaxAge: 60,
      });
      if (blobs.length) await del(blobs.map((b) => b.url));
      return res.status(200).json(about);
    }

    if (body.action === 'create') {
      const title = clean(body.title, 200);
      const content = clean(body.content, 50000);
      if (!title && !content) return res.status(400).json({ error: 'Write something first' });
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const images = await saveImages((body.newImages || []).slice(0, MAX_IMAGES), id);
      const post = {
        id,
        title,
        content,
        positions: clean(body.positions, 1000),
        category: cat(body.category),
        images,
        createdAt: new Date().toISOString(),
      };
      await writePost(post);
      return res.status(200).json(post);
    }

    if (body.action === 'update' || body.action === 'delete') {
      const posts = await loadPosts();
      const existing = posts.find((p) => p.id === body.id);
      if (!existing) return res.status(404).json({ error: 'Post not found' });

      if (body.action === 'delete') {
        await del([existing._blobUrl, ...(existing.images || [])]);
        return res.status(200).json({ ok: true });
      }

      const keep = (existing.images || []).filter((u) => (body.keepImages || []).includes(u));
      const removed = (existing.images || []).filter((u) => !keep.includes(u));
      const added = await saveImages(
        (body.newImages || []).slice(0, Math.max(0, MAX_IMAGES - keep.length)),
        existing.id
      );
      const { _blobUrl, ...rest } = existing;
      const post = {
        ...rest,
        title: clean(body.title, 200),
        content: clean(body.content, 50000),
        positions: clean(body.positions, 1000),
        category: cat(body.category),
        images: [...keep, ...added],
        updatedAt: new Date().toISOString(),
      };
      await writePost(post);
      await del([_blobUrl, ...removed]);
      return res.status(200).json(post);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error: ' + (err.message || 'unknown') });
  }
}
