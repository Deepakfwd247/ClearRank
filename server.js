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
const { google } = require('googleapis'); // <-- ADDED: Google Official Library
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
    // ✅ NOW USING DYNAMIC BASE_URL
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
                // If they don't exist, create a brand new row
                user = await prisma.user.create({
                    data: {
                        googleId: googleIdStr,
                        email: emailStr,
                        displayName: nameStr,
                        accessToken: accessToken || null,
                        refreshToken: refreshToken || null,
                    }
                });
                console.log(`💾 New user saved to database: ${user.email}`);
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

// Middleware to check if a user is securely logged in
function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    // If not logged in, kick them out with a 401 error
    res.status(401).json({ error: 'You must be logged in to access this data.' });
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
        // req.user is now our database User object
        console.log(`✅ User ${req.user.displayName} successfully logged in!`);
        res.redirect('/dashboard.html');
    }
);

/**
 * Route: GET /api/gsc/sites
 * Description: Fetches a list of all websites the logged-in user owns in GSC.
 */
app.get('/api/gsc/sites', isAuthenticated, async (req, res) => {
    try {
        console.log(`🌐 Fetching Search Console sites for: ${req.user.email}`);

        // 1. Create a temporary Google client using your app's credentials
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );

        // 2. Load the user's specific access token from your database
        oauth2Client.setCredentials({ access_token: req.user.accessToken });

        // 3. Initialize the Search Console API
        const searchConsole = google.webmasters({
            version: 'v3',
            auth: oauth2Client
        });

        // 4. Ask Google for the list of websites
        const response = await searchConsole.sites.list();

        // 5. Send the list back to the browser
        res.json({
            status: 'success',
            sites: response.data.siteEntry || [] // Returns an empty array if they have no sites
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
                    price: process.env.STRIPE_PRICE_ID, // Connects to your $49/mo product
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            // ✅ NOW USING DYNAMIC BASE_URL
            success_url: `${BASE_URL}/api/auth/google`,
            cancel_url: `${BASE_URL}/`,
        });

        // Send the user to the secure Stripe-hosted checkout page
        res.redirect(session.url);
    } catch (error) {
        console.error('❌ Stripe Error:', error.message);
        res.status(500).send('Failed to initiate checkout.');
    }
});

/**
 * Route: POST /api/analyze-intent
 * Description: Fetches REAL data from Google Search Console and sends it to Gemini.
 */
app.post('/api/analyze-intent', isAuthenticated, async (req, res) => {
    try {
        const { siteUrl } = req.body;

        if (!siteUrl || siteUrl.includes('Loading sites')) {
            return res.status(400).json({ status: 'error', message: 'Please select a valid website from the dropdown.' });
        }

        console.log(`🌐 Fetching live Search Console data for: ${siteUrl}`);

        // 1. Authenticate with Google
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ access_token: req.user.accessToken });

        const searchConsole = google.webmasters({
            version: 'v3',
            auth: oauth2Client
        });

        // 2. Set the Date Range (Last 30 Days)
        const today = new Date();
        const thirtyDaysAgo = new Date(today.setDate(today.getDate() - 30));
        const startDate = thirtyDaysAgo.toISOString().split('T')[0];
        const endDate = new Date().toISOString().split('T')[0];

        // 3. Ask Google for the exact URLs and Keywords
        const gscResponse = await searchConsole.searchanalytics.query({
            siteUrl: siteUrl,
            requestBody: {
                startDate: startDate,
                endDate: endDate,
                dimensions: ['query', 'page'], // We need both the keyword and the URL it ranks for
                rowLimit: 1000, // Limit to top 1000 rows to keep AI processing fast
            }
        });

        const rows = gscResponse.data.rows || [];

        if (rows.length === 0) {
            return res.json({ status: 'success', data: [] }); // No data found in the last 30 days
        }

        // 4. Format the raw Google data into a clean list for Gemini
        const formattedData = rows.map(row => ({
            query: row.keys[0],
            url: row.keys[1],
            clicks: row.clicks,
            impressions: row.impressions
        }));

        console.log(`🧠 Downloaded ${formattedData.length} live rows. Sending to Gemini 2.5 Flash...`);

        // 5. Send the real data to the AI Engine
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
 * Description: Public sandbox route. Takes raw keywords from the landing page, 
 * generates mock URLs/traffic to satisfy the AI schema, and returns the clusters.
 */
app.post('/api/demo-analyze', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ status: 'error', message: 'No keywords provided.' });
        }

        // Split the pasted text by lines and clean it up
        const keywords = text.split('\n').map(k => k.trim()).filter(k => k.length > 0);

        if (keywords.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Please paste at least two keywords.' });
        }

        console.log(`🚀 Running Public Demo for ${keywords.length} keywords...`);

        // Generate fake GSC metrics and dummy URLs so the AI has context to process
        const mockGscData = keywords.map((kw, index) => ({
            query: kw,
            url: `https://yourwebsite.com/page-${index + 1}`,
            clicks: Math.floor(Math.random() * 800) + 50,
            impressions: Math.floor(Math.random() * 8000) + 500
        }));

        // Send the generated spreadsheet to Gemini
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