require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();

// 1. MIDDLEWARE
app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
})); 
app.use(express.json());       

// Request Logger
app.use((req, res, next) => {
    console.log(`>>> ${req.method} request to ${req.url}`);
    next();
});

// 2. DATABASE CONNECTION
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ CONNECTED TO MONGODB ATLAS"))
    .catch(err => console.log("❌ CONNECTION ERROR:", err));

// 3. THE DATA STRUCTURE (Schema Updated for Referrals)
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    faceData: { type: Array, default: [] },
    balance: { type: Number, default: 0 },
    miners: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    // --- Referral Fields ---
    referredBy: { type: String, default: null },
    team: { type: Array, default: [] },
    referralBonus: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// 4. ROUTES
// Route to trigger STK Push
app.post('/api/deposit/stk', async (req, res) => {
    const { phone, amount } = req.body;

    try {
        const megapayResponse = await axios.post('https://api.megapay.co.ke/v1/stk/push', {
            api_key: "MGPYg3eI1jd2", // Get this from MegaPay Dashboard
            amount: amount,
            phone: phone,
            callback_url: "https://urbaninvest.onrender.com/api/deposit/callback",
            description: "Account Deposit"
        });

        if (megapayResponse.data.success) {
            res.status(200).json({ status: "Sent" });
        } else {
            res.status(400).json({ message: "STK Failed" });
        }
    } catch (error) {
        res.status(500).json({ error: "Server Error" });
    }
});
// MegaPay calls this after the user pays
app.post('/api/deposit/callback', async (req, res) => {
    const { status, phone, amount, transaction_id } = req.body;

    if (status === 'Success') {
        try {
            // Find the user in your MongoDB
            const user = await User.findOne({ phone: phone });
            
            if (user) {
                user.balance = (parseFloat(user.balance) || 0) + parseFloat(amount);
                
                // Add to transaction history
                user.transactions.push({
                    id: transaction_id || 'MP' + Math.floor(Math.random()*1000),
                    type: 'Deposit',
                    amount: parseFloat(amount),
                    date: new Date().toLocaleString()
                });

                await user.save();
                console.log(`Success: KES ${amount} added to ${phone}`);
            }
        } catch (err) {
            console.error("Database error during callback:", err);
        }
    }
    res.sendStatus(200); // Tell MegaPay we received the data
});
// Route to fetch a single user's latest data
app.get('/api/users/profile', async (req, res) => {
    try {
        // We get the phone number from the URL query (e.g., /api/users/profile?phone=2547...)
        const phone = req.query.phone;

        if (!phone) {
            return res.status(400).json({ error: "Phone number is required" });
        }

        // Search your MongoDB for this user
        const user = await User.findOne({ phone: phone });

        if (user) {
            // Return the full user object (including the new balance)
            res.json(user);
        } else {
            res.status(404).json({ message: "User not found" });
        }
    } catch (err) {
        console.error("Profile Fetch Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// Admin Route: Delete User
app.post('/api/admin/delete-user', async (req, res) => {
    try {
        const { phone } = req.body;
        await User.findOneAndDelete({ phone: phone });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete" });
    }
});
// Get all users for Admin Dashboard
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}); // Fetches everything from MongoDB
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});
// GET USER PROFILE
app.get('/api/users/profile', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

// UPDATE USER DATA (Rentals, Balance, etc.)
app.post('/api/users/update', async (req, res) => {
    const { phone, balance, miners, transactions } = req.body;
    try {
        const updatedUser = await User.findOneAndUpdate(
            { phone: phone },
            { balance, miners, transactions },
            { new: true }
        );
        console.log(`✅ Data synced for: ${phone}`);
        res.json(updatedUser);
    } catch (err) {
        res.status(500).json({ error: "Failed to sync data to database" });
    }
});

// REGISTRATION ROUTE (With Referral Logic)
app.post('/api/register', async (req, res) => {
    try {
        const { phone, referredBy } = req.body;
        console.log("Registering user:", phone);

        // 1. Create the new user
        const newUser = new User(req.body);
        await newUser.save();

        // 2. Handle Referral Commission
        if (referredBy && referredBy !== phone) {
            const inviter = await User.findOne({ phone: referredBy });
            if (inviter) {
                const bonusAmount = 20; // KES 20 Reward
                
                // Update inviter's data
                inviter.team.push(phone); 
                inviter.balance += bonusAmount;
                inviter.referralBonus += bonusAmount;
                
                // Add transaction history for the inviter
                inviter.transactions.push({
                    id: 'REF' + Math.floor(Math.random() * 100000),
                    type: 'Referral Bonus',
                    amount: bonusAmount,
                    date: new Date().toLocaleString(),
                    detail: `Invited ${phone}`
                });

                await inviter.save();
                console.log(`🎁 Referral bonus of ${bonusAmount} sent to ${referredBy}`);
            }
        }

        console.log("✅ User Saved Successfully!");
        res.status(201).json({ message: "Account Created!" });
    } catch (err) {
        console.log("❌ Save Error:", err.message);
        res.status(400).json({ error: "Phone number already registered." });
    }
});

// LOGIN ROUTE
app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const user = await User.findOne({ phone, password });
        if (!user) return res.status(401).json({ error: "Invalid phone or password" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Server error during login" });
    }
});

// Face Data Route (For Face Unlock Sync)
app.get('/api/users/faces', async (req, res) => {
    try {
        const users = await User.find({ faceData: { $exists: true, $ne: [] } }, 'phone faceData');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch face data" });
    }
});

const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});