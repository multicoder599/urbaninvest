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

app.post('/api/deposit/callback', async (req, res) => {
    // MegaPay sends a mix of these fields depending on the version
    const data = req.body;
    console.log(">>> M-PESA CALLBACK RECEIVED:", data);

    // If ResponseCode is '0', the payment was successful
    if (data.ResponseCode === '0' || data.ResultCode === '0' || data.success === '200') {
        try {
            // MegaPay usually sends the phone as 'Msisdn' or 'phone'
            let rawPhone = data.Msisdn || data.phone || data.msisdn;
            let amount = data.TransactionAmount || data.amount;

            if (!rawPhone) {
                // If phone is missing in callback, we use the CheckoutRequestID to find the session
                // But for now, let's try to extract it from the data
                console.log("Phone missing in callback, check logs for data structure");
            }

            // Convert 254... to 0...
            let dbPhone = rawPhone;
            if (dbPhone && dbPhone.startsWith('254')) {
                dbPhone = '0' + dbPhone.substring(3);
            }

            const user = await User.findOne({ phone: dbPhone });

            if (user && amount) {
                user.balance = (parseFloat(user.balance) || 0) + parseFloat(amount);
                
                user.transactions.push({
                    id: data.TransactionReceipt || data.transaction_id || 'MP' + Date.now(),
                    type: 'Deposit',
                    amount: parseFloat(amount),
                    date: new Date().toLocaleString()
                });

                await user.save();
                console.log(`✅ SUCCESS: KES ${amount} added to ${dbPhone}`);
            }
        } catch (err) {
            console.error("Database error during callback:", err);
        }
    }
    
    // Tell MegaPay you received the message so they stop sending it
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