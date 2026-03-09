// ==========================================
// 1. Environment & Database Setup (MUST BE FIRST)
// ==========================================

const dotenv = require('dotenv');
dotenv.config();

// 🚨 DEBUG CHECK: This will tell us if your .env file is actually working
console.log("🔍 Database URL Check:", process.env.DATABASE_URL ? "✅ Loaded" : "❌ MISSING!");

const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// Create the database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Hand the pool to the Prisma Adapter
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ==========================================
// 2. Express & Middleware Setup
// ==========================================
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');
const { clusterKeywordsByIntent } = require('./services/intentEngine.js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// 🔥 THE MAGIC FIX: This automatically switches between localhost and your live Render URL
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// Set up server memory for logged-in users
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: true
}));

// ==========================================
// 3. Passport & Authentication
// ==========================================
app.use(passport.initialize());
app.use(passport.session());

// Save only the User ID to the session cookie
passport.serializeUser((user, done) => done(null, user.id));

// Fetch full details from the database on page load
passport.deserializeUser(async (id, done) => {
    try {
        const user = await prisma.user.findUnique({ where: { id } });
        done(null, user);
    } catch (error) {
        done(error, null);
    }
});

// Configure the Google Strategy with manual Database Logic
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/api/auth/google/callback`
},
    async function (accessToken, refreshToken, profile, done) {
        try {
            console.log(`🎟️ Access Token Received for: ${profile.displayName}`);

            const googleIdStr = String(profile.id);
            const emailStr = profile.emails[0].value;
            const nameStr = profile.displayName || null;

            // Manually check if the user already exists
            let user = await prisma.user.findUnique({
                where: { googleId: googleIdStr }
            });

            if (user) {
                // If they exist, update their tokens
                user = await prisma.user.update({
                    where: { googleId: googleIdStr },
                    data: {
                        accessToken: accessToken || null,
                        ...(refreshToken ? { refreshToken: refreshToken } : {}),
                        displayName: nameStr,
                    }
                });
                console.log(`♻️ User updated in database: ${user.email}`);
            } else {
                // Set the trial timer to 7 days from right now
                const trialExpiration = new Date();
                trialExpiration.setDate(trialExpiration.getDate() + 7);

                // If they don't exist, create a brand new row with the timer
                user = await prisma.user.create({
                    data: {
                        googleId: googleIdStr,
                        email: emailStr,
                        displayName: nameStr,
                        accessToken: accessToken || null,
                        refreshToken: refreshToken || null,
                        trialEndsAt: trialExpiration,
                        isPro: false
                    }
                });
                console.log(`💾 New user saved. Trial ends: ${trialExpiration}`);
            }

            return done(null, user);

        } catch (error) {
            console.error('❌ Database error during login:');
            console.dir(error, { depth: null });
            return done(error, null);
        }
    }
));

// ==========================================
// 4. API Routes
// ==========================================

// Middleware to check if a user is securely logged in (General)
function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ error: 'You must be logged in to access this data.' });
}

// 🛑 Middleware to check if their trial is valid or if they paid
function hasActiveAccess(req, res, next) {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Please log in.' });
    }

    const user = req.user;
    const now = new Date();

    // 1. If they manually paid, let them in forever
    if (user.isPro) return next();

    // 2. If their 7-day trial is still active, let them in
    if (user.trialEndsAt && new Date(user.trialEndsAt) > now) {
        return next();
    }

    // 3. Trial expired! Kick them to the Stripe checkout
    return res.status(403).json({
        error: 'Trial Expired',
        message: 'Your free trial has ended. Please upgrade to ClearRank Pro.',
        redirectUrl: '/checkout'
    });
}

/**
 * Route: GET /api/auth/status
 * Description: Lets the frontend check if the user is currently logged in via session cookie.
 */
app.get('/api/auth/status', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ loggedIn: true });
    } else {
        res.json({ loggedIn: false });
    }
});

app.get('/api/auth/google',
    passport.authenticate('google', {
        scope: ['profile', 'email', 'https://www.googleapis.com/auth/webmasters.readonly'],
        accessType: 'offline',
    })
);

app.get('/api/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    function (req, res) {
        console.log(`✅ User ${req.user.displayName} successfully logged in!`);
        res.redirect('/dashboard.html');
    }
);

/**
 * Route: GET /api/gsc/sites
 * Description: Fetches a list of all websites the logged-in user owns in GSC.
 * 🔒 USES hasActiveAccess (Blocks expired users)
 */
app.get('/api/gsc/sites', hasActiveAccess, async (req, res) => {
    try {
        console.log(`🌐 Fetching Search Console sites for: ${req.user.email}`);

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );

        oauth2Client.setCredentials({ access_token: req.user.accessToken });

        const searchConsole = google.webmasters({
            version: 'v3',
            auth: oauth2Client
        });

        const response = await searchConsole.sites.list();

        res.json({
            status: 'success',
            sites: response.data.siteEntry || []
        });

    } catch (error) {
        console.error('❌ Error fetching GSC sites:', error.message);
        res.status(500).json({ error: 'Failed to fetch sites from Google Search Console' });
    }
});

/**
 * Route: GET /checkout
 * Description: Generates a secure Stripe Checkout Session and redirects the user there.
 */
app.get('/checkout', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_ID,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${BASE_URL}/api/auth/google`,
            cancel_url: `${BASE_URL}/`,
        });

        res.redirect(session.url);
    } catch (error) {
        console.error('❌ Stripe Error:', error.message);
        res.status(500).send('Failed to initiate checkout.');
    }
});

/**
 * Route: POST /api/analyze-intent
 * Description: Fetches REAL data from Google Search Console and sends it to Gemini.
 * 🔒 USES hasActiveAccess (Blocks expired users)
 */
app.post('/api/analyze-intent', hasActiveAccess, async (req, res) => {
    try {
        const { siteUrl } = req.body;

        if (!siteUrl || siteUrl.includes('Loading sites')) {
            return res.status(400).json({ status: 'error', message: 'Please select a valid website from the dropdown.' });
        }

        console.log(`🌐 Fetching live Search Console data for: ${siteUrl}`);

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ access_token: req.user.accessToken });

        const searchConsole = google.webmasters({
            version: 'v3',
            auth: oauth2Client
        });

        const today = new Date();
        const thirtyDaysAgo = new Date(today.setDate(today.getDate() - 30));
        const startDate = thirtyDaysAgo.toISOString().split('T')[0];
        const endDate = new Date().toISOString().split('T')[0];

        const gscResponse = await searchConsole.searchanalytics.query({
            siteUrl: siteUrl,
            requestBody: {
                startDate: startDate,
                endDate: endDate,
                dimensions: ['query', 'page'],
                rowLimit: 1000,
            }
        });

        const rows = gscResponse.data.rows || [];

        if (rows.length === 0) {
            return res.json({ status: 'success', data: [] });
        }

        const formattedData = rows.map(row => ({
            query: row.keys[0],
            url: row.keys[1],
            clicks: row.clicks,
            impressions: row.impressions
        }));

        console.log(`🧠 Downloaded ${formattedData.length} live rows. Sending to Gemini...`);

        const clusters = await clusterKeywordsByIntent(formattedData);

        res.json({
            status: 'success',
            data: clusters
        });

    } catch (error) {
        console.error('❌ Server Error during live analysis:', error.message);
        res.status(500).json({ status: 'error', message: 'Failed to fetch or analyze live GSC data.' });
    }
});

/**
 * Route: POST /api/demo-analyze
 * Description: Public sandbox route. Takes raw keywords from the landing page.
 */
app.post('/api/demo-analyze', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ status: 'error', message: 'No keywords provided.' });
        }

        const keywords = text.split('\n').map(k => k.trim()).filter(k => k.length > 0);

        if (keywords.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Please paste at least two keywords.' });
        }

        console.log(`🚀 Running Public Demo for ${keywords.length} keywords...`);

        const mockGscData = keywords.map((kw, index) => ({
            query: kw,
            url: `https://yourwebsite.com/page-${index + 1}`,
            clicks: Math.floor(Math.random() * 800) + 50,
            impressions: Math.floor(Math.random() * 8000) + 500
        }));

        const clusters = await clusterKeywordsByIntent(mockGscData);

        res.json({
            status: 'success',
            data: clusters
        });

    } catch (error) {
        console.error('❌ Server Error during demo analysis:', error.message);
        res.status(500).json({ status: 'error', message: 'Failed to process demo data.' });
    }
});

// Fallback route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 5. Start Server
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 ClearRank Backend Server is running on ${BASE_URL}`);
});