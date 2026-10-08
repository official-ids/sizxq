// api/reviews.js
import { kv } from '@vercel/kv';

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeInput(str) {
  if (!str) return '';
  return str.toString().trim().replace(/[<>]/g, '');
}

function validateRobloxUsername(username) {
  if (!username) return true; // Optional
  const clean = username.trim();
  return clean.length >= 3 && clean.length <= 20 && /^[a-zA-Z0-9_]+$/.test(clean);
}

async function verifySession(token) {
  if (!token) return null;
  try {
    const username = await kv.get(`session:${token}`);
    if (!username) return null;
    return await kv.get(`user:${username}`);
  } catch {
    return null;
  }
}

async function getRobloxAvatar(username) {
  try {
    const userId = await fetch(`https://users.roblox.com/v1/usernames/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
    }).then(r => r.json()).then(d => d.data?.[0]?.id);

    if (!userId) return null;

    const thumbnail = await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)
      .then(r => r.json())
      .then(d => d.data?.[0]?.imageUrl);

    return thumbnail || null;
  } catch {
    return null;
  }
}

// ============================================
// MAIN HANDLER
// ============================================

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { method } = req;
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await verifySession(token);

  try {
    // ========================================
    // AUTH ENDPOINTS
    // ========================================

    // REGISTER
    if (method === 'POST' && req.url === '/api/reviews/auth/register') {
      if (!user) {
        const { username, password, displayName } = await req.json();

        const cleanUsername = sanitizeInput(username);
        const cleanDisplayName = sanitizeInput(displayName) || cleanUsername;

        if (!cleanUsername || cleanUsername.length < 3 || cleanUsername.length > 20) {
          return res.status(400).json({ error: 'Username must be 3-20 characters' });
        }

        if (!password || password.length < 4) {
          return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }

        const existing = await kv.get(`user:${cleanUsername}`);
        if (existing) {
          return res.status(409).json({ error: 'Username already exists' });
        }

        const newUser = {
          username: cleanUsername,
          password, // In production, hash this!
          displayName: cleanDisplayName,
          robloxUsername: null,
          avatarMode: 'none', // 'none' | 'roblox' | 'upload'
          avatarUrl: null,
          createdAt: new Date().toISOString(),
          reviewsCount: 0,
          totalLikes: 0,
        };

        await kv.set(`user:${cleanUsername}`, newUser);
        await kv.sadd('users:all', cleanUsername);

        const sessionToken = `${cleanUsername}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        await kv.set(`session:${sessionToken}`, cleanUsername, { ex: 86400 * 30 }); // 30 days

        return res.status(201).json({
          token: sessionToken,
          user: { ...newUser, password: undefined }
        });
      }
      return res.status(400).json({ error: 'Already authenticated' });
    }

    // LOGIN
    if (method === 'POST' && req.url === '/api/reviews/auth/login') {
      if (user) {
        return res.status(400).json({ error: 'Already authenticated' });
      }

      const { username, password } = await req.json();
      const cleanUsername = sanitizeInput(username);

      const existingUser = await kv.get(`user:${cleanUsername}`);
      if (!existingUser || existingUser.password !== password) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const sessionToken = `${cleanUsername}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      await kv.set(`session:${sessionToken}`, cleanUsername, { ex: 86400 * 30 });

      return res.status(200).json({
        token: sessionToken,
        user: { ...existingUser, password: undefined }
      });
    }

    // LOGOUT
    if (method === 'POST' && req.url === '/api/reviews/auth/logout') {
      if (token) {
        await kv.del(`session:${token}`);
      }
      return res.status(200).json({ success: true });
    }

    // GET CURRENT USER
    if (method === 'GET' && req.url === '/api/reviews/auth/me') {
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      return res.status(200).json({ ...user, password: undefined });
    }

    // UPDATE PROFILE
    if (method === 'PUT' && req.url === '/api/reviews/auth/profile') {
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { displayName, robloxUsername, avatarMode, avatarUrl } = await req.json();

      const updates = {};
      if (displayName !== undefined) {
        updates.displayName = sanitizeInput(displayName) || user.username;
      }

      if (robloxUsername !== undefined) {
        const cleanRoblox = robloxUsername ? sanitizeInput(robloxUsername) : null;
        if (cleanRoblox && !validateRobloxUsername(cleanRoblox)) {
          return res.status(400).json({ error: 'Invalid Roblox username' });
        }
        updates.robloxUsername = cleanRoblox;
      }

      if (avatarMode !== undefined) {
        if (!['none', 'roblox', 'upload'].includes(avatarMode)) {
          return res.status(400).json({ error: 'Invalid avatar mode' });
        }
        updates.avatarMode = avatarMode;
      }

      if (avatarUrl !== undefined) {
        updates.avatarUrl = avatarUrl ? sanitizeInput(avatarUrl) : null;
      }

      // Auto-fetch Roblox avatar if mode is 'roblox' and username is set
      if (updates.avatarMode === 'roblox' && updates.robloxUsername) {
        const avatar = await getRobloxAvatar(updates.robloxUsername);
        if (avatar) {
          updates.avatarUrl = avatar;
        }
      } else if (updates.avatarMode === 'roblox' && user.robloxUsername) {
        const avatar = await getRobloxAvatar(user.robloxUsername);
        if (avatar) {
          updates.avatarUrl = avatar;
        }
      }

      const updatedUser = { ...user, ...updates };
      await kv.set(`user:${user.username}`, updatedUser);

      return res.status(200).json({ ...updatedUser, password: undefined });
    }

    // ========================================
    // REVIEW ENDPOINTS
    // ========================================

    // CREATE REVIEW
    if (method === 'POST' && req.url === '/api/reviews') {
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { content, rating, serviceName } = await req.json();
      const cleanContent = sanitizeInput(content);
      const cleanServiceName = sanitizeInput(serviceName);

      if (!cleanContent || cleanContent.length < 10) {
        return res.status(400).json({ error: 'Review must be at least 10 characters' });
      }

      if (cleanContent.length > 2000) {
        return res.status(400).json({ error: 'Review must be less than 2000 characters' });
      }

      const numRating = parseInt(rating);
      if (isNaN(numRating) || numRating < 1 || numRating > 5) {
        return res.status(400).json({ error: 'Rating must be 1-5' });
      }

      const review = {
        id: generateId(),
        authorUsername: user.username,
        authorDisplayName: user.displayName,
        authorAvatar: user.avatarUrl,
        authorRoblox: user.robloxUsername,
        content: cleanContent,
        rating: numRating,
        serviceName: cleanServiceName || 'POZZINGSX',
        likes: 0,
        dislikes: 0,
        likedBy: [],
        dislikedBy: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isEdited: false,
        embedCount: 0,
      };

      await kv.set(`review:${review.id}`, review);
      await kv.zadd('reviews:recent', { score: Date.now(), member: review.id });
      await kv.incr(`user:${user.username}:reviewsCount`);

      // Update user stats
      user.reviewsCount = (user.reviewsCount || 0) + 1;
      await kv.set(`user:${user.username}`, user);

      return res.status(201).json(review);
    }

    // GET ALL REVIEWS (PAGINATED)
    if (method === 'GET' && req.url.startsWith('/api/reviews')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const page = parseInt(url.searchParams.get('page')) || 1;
      const limit = Math.min(parseInt(url.searchParams.get('limit')) || 10, 50);
      const sortBy = url.searchParams.get('sort') || 'recent'; // 'recent' | 'top' | 'rating'
      const rating = url.searchParams.get('rating');
      const search = url.searchParams.get('search');

      let reviewIds;

      if (sortBy === 'recent') {
        reviewIds = await kv.zrange('reviews:recent', 0, -1, { rev: true });
      } else if (sortBy === 'top') {
        reviewIds = await kv.zrange('reviews:likes', 0, -1, { rev: true });
      } else {
        // Get all and sort by rating
        const allIds = await kv.keys('review:*');
        reviewIds = allIds.map(k => k.replace('review:', ''));
      }

      // Filter by rating
      if (rating) {
        const ratingNum = parseInt(rating);
        if (!isNaN(ratingNum) && ratingNum >= 1 && ratingNum <= 5) {
          const filtered = [];
          for (const id of reviewIds) {
            const review = await kv.get(`review:${id}`);
            if (review && review.rating === ratingNum) {
              filtered.push(id);
            }
          }
          reviewIds = filtered;
        }
      }

      // Search
      if (search) {
        const searchLower = search.toLowerCase();
        const filtered = [];
        for (const id of reviewIds) {
          const review = await kv.get(`review:${id}`);
          if (review && (
            review.content.toLowerCase().includes(searchLower) ||
            review.authorDisplayName.toLowerCase().includes(searchLower) ||
            (review.authorRoblox && review.authorRoblox.toLowerCase().includes(searchLower))
          )) {
            filtered.push(id);
          }
        }
        reviewIds = filtered;
      }

      // Pagination
      const start = (page - 1) * limit;
      const end = start + limit;
      const pageIds = reviewIds.slice(start, end);

      const reviews = [];
      for (const id of pageIds) {
        const review = await kv.get(`review:${id}`);
        if (review) {
          // Check if current user liked/disliked
          if (user) {
            review.userLiked = review.likedBy?.includes(user.username);
            review.userDisliked = review.dislikedBy?.includes(user.username);
          }
          reviews.push(review);
        }
      }

      const total = reviewIds.length;

      return res.status(200).json({
        reviews,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1,
        }
      });
    }

    // GET SINGLE REVIEW
    if (method === 'GET' && req.url.match(/^\/api\/reviews\/[a-zA-Z0-9-]+$/)) {
      const id = req.url.split('/').pop();
      const review = await kv.get(`review:${id}`);

      if (!review) {
        return res.status(404).json({ error: 'Review not found' });
      }

      if (user) {
        review.userLiked = review.likedBy?.includes(user.username);
        review.userDisliked = review.dislikedBy?.includes(user.username);
      }

      // Increment view count
      await kv.incr(`review:${id}:views`);

      return res.status(200).json(review);
    }

    // UPDATE REVIEW
    if (method === 'PUT' && req.url.match(/^\/api\/reviews\/[a-zA-Z0-9-]+$/)) {
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const id = req.url.split('/').pop();
      const review = await kv.get(`review:${id}`);

      if (!review) {
        return res.status(404).json({ error: 'Review not found' });
      }

      if (review.authorUsername !== user.username) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const { content, rating, serviceName } = await req.json();
      const cleanContent = sanitizeInput(content);
      const cleanServiceName = sanitizeInput(serviceName);

      if (cleanContent) {
        if (cleanContent.length < 10) {
          return res.status(400).json({ error: 'Review must be at least 10 characters' });
        }
        if (cleanContent.length > 2000) {
          return res.status(400).json({ error: 'Review must be less than 2000 characters' });
        }
        review.content = cleanContent;
      }

      if (rating !== undefined) {
        const numRating = parseInt(rating);
        if (isNaN(numRating) || numRating < 1 || numRating > 5) {
          return res.status(400).json({ error: 'Rating must be 1-5' });
        }
        review.rating = numRating;
      }

      if (serviceName !== undefined) {
        review.serviceName = cleanServiceName || 'POZZINGSX';
      }

      review.updatedAt = new Date().toISOString();
      review.isEdited = true;

      await kv.set(`review:${id}`, review);

      return res.status(200).json(review);
    }

    // DELETE REVIEW
    if (method === 'DELETE' && req.url.match(/^\/api\/reviews\/[a-zA-Z0-9-]+$/)) {
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const id = req.url.split('/').pop();
      const review = await kv.get(`review:${id}`);

      if (!review) {
        return res.status(404).json({ error: 'Review not found' });
      }

      if (review.authorUsername !== user.username) {
        // Check if admin
        const isAdmin = process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
        if (!isAdmin) {
          return res.status(403).json({ error: 'Not authorized' });
        }
      }

      await kv.del(`review:${id}`);
      await kv.zrem('reviews:recent', id);
      await kv.zrem('reviews:likes', id);

      // Decrement user stats
      const author = await kv.get(`user:${review.authorUsername}`);
      if (author) {
        author.reviewsCount = Math.max(0, (author.reviewsCount || 1) - 1);
        await kv.set(`user:${review.authorUsername}`, author);
      }

      return res.status(200).json({ success: true });
    }

    // LIKE REVIEW
    if (method === 'POST' && req.url.match(/^\/api\/reviews\/[a-zA-Z0-9-]+\/like$/)) {
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const id = req.url.split('/')[3];
      const review = await kv.get(`review:${id}`);

      if (!review) {
        return res.status(404).json({ error: 'Review not found' });
      }

      // Remove dislike if exists
      if (review.dislikedBy?.includes(user.username)) {
        review.dislikedBy = review.dislikedBy.filter(u => u !== user.username);
        review.dislikes = Math.max(0, review.dislikes - 1);
      }

      // Toggle like
      if (review.likedBy?.includes(user.username)) {
        review.likedBy = review.likedBy.filter(u => u !== user.username);
        review.likes = Math.max(0, review.likes - 1);
        await kv.zincrby('reviews:likes', -1, id);
      } else {
        if (!review.likedBy) review.likedBy = [];
        review.likedBy.push(user.username);
        review.likes += 1;
        await kv.zincrby('reviews:likes', 1, id);
      }

      review.updatedAt = new Date().toISOString();
      await kv.set(`review:${id}`, review);

      return res.status(200).json(review);
    }

    // DISLIKE REVIEW
    if (method === 'POST' && req.url.match(/^\/api\/reviews\/[a-zA-Z0-9-]+\/dislike$/)) {
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const id = req.url.split('/')[3];
      const review = await kv.get(`review:${id}`);

      if (!review) {
        return res.status(404).json({ error: 'Review not found' });
      }

      // Remove like if exists
      if (review.likedBy?.includes(user.username)) {
        review.likedBy = review.likedBy.filter(u => u !== user.username);
        review.likes = Math.max(0, review.likes - 1);
        await kv.zincrby('reviews:likes', -1, id);
      }

      // Toggle dislike
      if (review.dislikedBy?.includes(user.username)) {
        review.dislikedBy = review.dislikedBy.filter(u => u !== user.username);
        review.dislikes = Math.max(0, review.dislikes - 1);
      } else {
        if (!review.dislikedBy) review.dislikedBy = [];
        review.dislikedBy.push(user.username);
        review.dislikes += 1;
      }

      review.updatedAt = new Date().toISOString();
      await kv.set(`review:${id}`, review);

      return res.status(200).json(review);
    }

    // GET REVIEW STATS
    if (method === 'GET' && req.url === '/api/reviews/stats') {
      const totalReviews = await kv.zcard('reviews:recent');
      const allIds = await kv.zrange('reviews:recent', 0, -1);

      let totalLikes = 0;
      let totalRating = 0;
      const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

      for (const id of allIds) {
        const review = await kv.get(`review:${id}`);
        if (review) {
          totalLikes += review.likes || 0;
          totalRating += review.rating || 0;
          ratingDistribution[review.rating] = (ratingDistribution[review.rating] || 0) + 1;
        }
      }

      const avgRating = totalReviews > 0 ? (totalRating / totalReviews).toFixed(1) : 0;

      return res.status(200).json({
        totalReviews,
        totalLikes,
        avgRating,
        ratingDistribution,
      });
    }

    // EMBED REVIEW
    if (method === 'GET' && req.url.match(/^\/api\/reviews\/[a-zA-Z0-9-]+\/embed$/)) {
      const id = req.url.split('/')[3];
      const review = await kv.get(`review:${id}`);

      if (!review) {
        return res.status(404).json({ error: 'Review not found' });
      }

      // Increment embed count
      review.embedCount = (review.embedCount || 0) + 1;
      await kv.set(`review:${id}`, review);

      const embedUrl = `${process.env.VERCEL_URL || 'localhost:3000'}/embed/${id}`;

      return res.status(200).json({
        embedUrl,
        embedCode: `<iframe src="${embedUrl}" width="100%" height="400" frameborder="0" allowfullscreen></iframe>`,
        review
      });
    }

    // GET USER REVIEWS
    if (method === 'GET' && req.url.match(/^\/api\/reviews\/user\/[a-zA-Z0-9_]+$/)) {
      const username = req.url.split('/').pop();
      const userExists = await kv.get(`user:${username}`);

      if (!userExists) {
        return res.status(404).json({ error: 'User not found' });
      }

      const allIds = await kv.zrange('reviews:recent', 0, -1);
      const userReviews = [];

      for (const id of allIds) {
        const review = await kv.get(`review:${id}`);
        if (review && review.authorUsername === username) {
          userReviews.push(review);
        }
      }

      return res.status(200).json({
        username,
        reviews: userReviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
        total: userReviews.length
      });
    }

    // SEARCH REVIEWS
    if (method === 'GET' && req.url === '/api/reviews/search') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const query = url.searchParams.get('q');

      if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Search query must be at least 2 characters' });
      }

      const allIds = await kv.zrange('reviews:recent', 0, -1);
      const results = [];
      const searchLower = query.toLowerCase();

      for (const id of allIds) {
        const review = await kv.get(`review:${id}`);
        if (review && (
          review.content.toLowerCase().includes(searchLower) ||
          review.authorDisplayName.toLowerCase().includes(searchLower) ||
          (review.authorRoblox && review.authorRoblox.toLowerCase().includes(searchLower)) ||
          review.serviceName.toLowerCase().includes(searchLower)
        )) {
          results.push(review);
        }
      }

      return res.status(200).json({
        query,
        results,
        total: results.length
      });
    }

    // ========================================
    // DEFAULT
    // ========================================

    return res.status(404).json({ error: 'Not found' });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}