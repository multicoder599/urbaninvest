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
    const data = req.body;
    console.log(">>> CALLBACK RECEIVED:", JSON.stringify(data));

    try {
        // 1. FLEXIBLE SUCCESS CHECK
        const success =
            data.ResponseCode == 0 ||
            data.ResponseCode == '0' ||
            data.status === 'success' ||
            data.ResultCode == 0 ||
            (data.ResultDesc && data.ResultDesc.toLowerCase().includes("success")) ||
            (data.ResponseDescription && data.ResponseDescription.toLowerCase().includes("success"));

        if (!success) {
            console.log("❌ Payment marked as failed by MegaPay");
            return res.status(200).send("OK"); // Still acknowledge so they stop sending
        }

        // 2. PHONE EXTRACTION
        let rawPhone = data.Msisdn || data.phone || data.PhoneNumber || data.CustomerPhoneNumber || data.Msisdn_ID;

        if (!rawPhone) {
            console.log("❌ No phone found in callback data. Available keys:", Object.keys(data));
            return res.status(200).send("OK");
        }

        // Convert 254 → 0
        rawPhone = rawPhone.toString();
        if (rawPhone.startsWith('254')) {
            rawPhone = '0' + rawPhone.slice(3);
        }

        const amount = data.TransactionAmount || data.amount || data.Amount || data.transAmount;
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.transaction_id || data.CheckoutRequestID;

        console.log(`🔍 Searching for user: ${rawPhone} to credit KES ${amount}`);

        // 3. FIND USER
        const user = await User.findOne({ phone: rawPhone });

        if (!user) {
            console.log("❌ User not found in database for phone:", rawPhone);
            return res.status(200).send("OK");
        }

        // 4. PREVENT DOUBLE CREDIT
        const exists = user.transactions.find(t => t.id == receipt);
        if (exists) {
            console.log("⚠ Duplicate transaction ignored:", receipt);
            return res.status(200).send("OK");
        }

        // 5. CREDIT USER
        const deposit = parseFloat(amount) || 0;
        user.balance = (parseFloat(user.balance) || 0) + deposit;

        user.transactions.push({
            id: receipt || "MP" + Date.now(),
            type: "Deposit",
            amount: deposit,
            date: new Date().toLocaleString()
        });

        await user.save();
        console.log(`✅ SUCCESS: Credited KES ${deposit} to ${rawPhone}. New Balance: ${user.balance}`);

        // 6. FINALLY ACKNOWLEDGE
        res.status(200).send("OK");

    } catch (err) {
        console.error("🔥 CALLBACK ERROR:", err);
        res.status(500).send("Error");
    }
});

// GET USER PROFILE
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