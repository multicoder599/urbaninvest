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

// FIXED STK PUSH ROUTE
app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;

    // Format Phone to 254...
    let formattedPhone = phone;
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('+')) {
        formattedPhone = formattedPhone.substring(1);
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

    // Updated endpoints based on your latest successful log
    const endpoints = [
        'https://megapay.co.ke/backend/v1/initiatestk',
        'https://api.megapay.africa/v1/stk/push'
    ];

    for (let url of endpoints) {
        try {
            console.log(`Trying MegaPay at: ${url}`);
            const response = await axios.post(url, payload, { timeout: 10000 });
            
            console.log("MegaPay Response:", response.data);
            
            // ResponseCode '0' or success '200' means the prompt was sent
            if (response.data.ResponseCode === '0' || response.data.success === '200') {
                return res.status(200).json({ status: "Sent" });
            }
        } catch (error) {
            console.error(`Failed at ${url}:`, error.message);
        }
    }

    res.status(500).json({ error: "Could not initiate payment. Please try again." });
});

// FIXED CALLBACK ROUTE (Matches the data you saw on MegaPay)
app.post('/api/deposit/callback', async (req, res) => {
    const data = req.body;
    console.log(">>> Incoming Payment Callback:", data);

    // MegaPay uses ResponseDescription or ResultDesc to indicate success
    const isSuccess = (data.ResponseCode === '0' || 
                       (data.ResponseDescription && data.ResponseDescription.includes('Success')) ||
                       (data.ResultDesc && data.ResultDesc.includes('processed successfully')));

    if (isSuccess) {
        try {
            // Extract values using various possible keys from MegaPay
            const rawPhone = data.Msisdn || data.phone || data.PhoneNumber;
            const amount = data.TransactionAmount || data.amount || data.Amount;
            const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.transaction_id;

            if (!rawPhone) {
                console.log("❌ Callback error: No phone number found in data");
                return res.status(200).send("OK"); 
            }

            // Convert 254... to 0... to match your MongoDB records
            let dbPhone = rawPhone.toString();
            if (dbPhone.startsWith('254')) {
                dbPhone = '0' + dbPhone.substring(3);
            }

            const user = await User.findOne({ phone: dbPhone });
            
            if (user) {
                const depositAmount = parseFloat(amount);
                user.balance = (parseFloat(user.balance) || 0) + depositAmount;
                
                user.transactions.push({
                    id: receipt || 'MP' + Math.floor(Math.random()*100000),
                    type: 'Deposit',
                    amount: depositAmount,
                    date: new Date().toLocaleString()
                });

                await user.save();
                console.log(`✅ Balance Updated: KES ${depositAmount} added to ${dbPhone}`);
            } else {
                console.log(`❌ User not found for phone: ${dbPhone}`);
            }
        } catch (err) {
            console.error("Database error during callback:", err);
        }
    }
    
    // Always acknowledge with 200 so MegaPay doesn't keep retrying
    res.status(200).send("OK");
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