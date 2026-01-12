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

// 3. THE DATA STRUCTURE
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    faceData: { type: Array, default: [] },
    balance: { type: Number, default: 0 },
    miners: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    referredBy: { type: String, default: null },
    team: { type: Array, default: [] },
    referralBonus: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;

    // Format Phone to 254...
    let formattedPhone = phone;
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
    }

    const payload = {
        api_key: "MGPYg3eI1jd2",
        amount: amount,
        msisdn: formattedPhone,
        email: "newtonmulti@gmail.com",
        callback_url: "https://urbaninvest.onrender.com/api/deposit/callback",
        description: "Deposit",
        reference: "UI" + Date.now()
    };

    // We will try the two most likely working endpoints
    const endpoints = [
        'https://api.megapay.africa/v1/stk/push',
        'https://megapay.co.ke/backend/v1/initiatestk'
    ];

    for (let url of endpoints) {
        try {
            console.log(`Trying MegaPay at: ${url}`);
            const response = await axios.post(url, payload, { timeout: 5000 });
            
            console.log("MegaPay Response:", response.data);
            
            if (response.data.success || response.data.ResultCode === '0') {
                return res.status(200).json({ status: "Sent" });
            }
        } catch (error) {
            console.error(`Failed at ${url}:`, error.message);
            // Continue to the next URL in the list
        }
    }

    // If we reach here, both failed
    res.status(500).json({ error: "All payment gateways are currently unreachable." });
});

app.post('/api/deposit/callback', async (req, res) => {
    // This matches the exact keys from the MegaPay JSON you provided
    const { 
        ResponseDescription, 
        Msisdn, 
        TransactionAmount, 
        TransactionReceipt 
    } = req.body;

    console.log(">>> Incoming Payment Callback:", req.body);

    // Check if the response says "Success"
    if (ResponseDescription && ResponseDescription.includes('Success')) {
        try {
            // Convert 254... to 0... to match your MongoDB records
            let dbPhone = Msisdn;
            if (dbPhone.startsWith('254')) {
                dbPhone = '0' + dbPhone.substring(3);
            }

            const user = await User.findOne({ phone: dbPhone });
            
            if (user) {
                const amount = parseFloat(TransactionAmount);
                user.balance = (parseFloat(user.balance) || 0) + amount;
                
                // Add to transaction history using MegaPay's keys
                user.transactions.push({
                    id: TransactionReceipt || 'MP' + Math.floor(Math.random()*1000),
                    type: 'Deposit',
                    amount: amount,
                    date: new Date().toLocaleString()
                });

                await user.save();
                console.log(`✅ Balance Updated: KES ${amount} added to ${dbPhone}`);
            } else {
                console.log(`❌ User not found for phone: ${dbPhone}`);
            }
        } catch (err) {
            console.error("Database error during callback:", err);
        }
    }
    
    // Always send 200 back to MegaPay so they stop retrying
    res.status(200).send("OK");
});

// GET USER PROFILE (Single Route)
app.get('/api/users/profile', async (req, res) => {
    try {
        const phone = req.query.phone;
        if (!phone) return res.status(400).json({ error: "Phone number required" });

        const user = await User.findOne({ phone: phone });
        if (user) {
            res.json(user);
        } else {
            res.status(404).json({ message: "User not found" });
        }
    } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// UPDATE USER DATA
app.post('/api/users/update', async (req, res) => {
    const { phone, balance, miners, transactions } = req.body;
    try {
        const updatedUser = await User.findOneAndUpdate(
            { phone: phone },
            { balance, miners, transactions },
            { new: true }
        );
        res.json(updatedUser);
    } catch (err) {
        res.status(500).json({ error: "Failed to sync data" });
    }
});

// ADMIN ROUTES
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({});
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

app.post('/api/admin/delete-user', async (req, res) => {
    try {
        const { phone } = req.body;
        await User.findOneAndDelete({ phone: phone });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete" });
    }
});

// REGISTRATION
app.post('/api/register', async (req, res) => {
    try {
        const { phone, referredBy } = req.body;
        const newUser = new User(req.body);
        await newUser.save();

        if (referredBy && referredBy !== phone) {
            const inviter = await User.findOne({ phone: referredBy });
            if (inviter) {
                const bonusAmount = 20; 
                inviter.team.push(phone); 
                inviter.balance += bonusAmount;
                inviter.referralBonus += bonusAmount;
                inviter.transactions.push({
                    id: 'REF' + Math.floor(Math.random() * 100000),
                    type: 'Referral Bonus',
                    amount: bonusAmount,
                    date: new Date().toLocaleString(),
                    detail: `Invited ${phone}`
                });
                await inviter.save();
            }
        }
        res.status(201).json({ message: "Account Created!" });
    } catch (err) {
        res.status(400).json({ error: "Phone number already registered." });
    }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const user = await User.findOne({ phone, password });
        if (!user) return res.status(401).json({ error: "Invalid login" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

// Face Data
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
    console.log(`🚀 Server running on port ${PORT}`);
});