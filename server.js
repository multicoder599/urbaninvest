require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();

// 1. MIDDLEWARE
app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
})); 
app.use(express.json());       

// 2. DATABASE CONNECTION
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ CONNECTED TO MONGODB ATLAS"))
    .catch(err => console.log("❌ CONNECTION ERROR:", err));

// 3. THE DATA STRUCTURE
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, unique: true, required: true, index: true },
    password: { type: String, required: true },
    withdrawPin: { type: String, default: "" },
    faceData: { type: Array, default: [] },
    balance: { type: Number, default: 0 },
    miners: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    referredBy: { type: String, default: null },
    team: { type: Array, default: [] },
    referralBonus: { type: Number, default: 0 },
    lastSpinDate: { type: Date, default: null } // Added for Bulletproof Spin Logic
});
const User = mongoose.model('User', userSchema);

// --- ADMIN SECURITY ---
const MASTER_KEY = process.env.ADMIN_KEY || "901363"; 

const checkAuth = (req, res, next) => {
    const key = req.headers['authorization'];
    if (key === MASTER_KEY) {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized Access" });
    }
};

// --- RENDER KEEP-ALIVE ---
const APP_URL = `https://urbaninvest.onrender.com`; 
setInterval(() => {
    axios.get(`${APP_URL}/ping`)
        .then(() => console.log("🛰️ Self-Ping: Stayin' Alive"))
        .catch((err) => console.log("🛰️ Self-Ping failed"));
}, 840000); 

app.get('/ping', (req, res) => res.status(200).send("Awake"));

// --- AUTH & PROFILE ROUTES ---

app.post('/api/register', async (req, res) => {
    try {
        const { fullName, phone, password, referralCode } = req.body;
        const newUser = new User({
            fullName,
            phone,
            password,
            referredBy: referralCode || null
        });

        if (referralCode) {
            const inviter = await User.findOne({ phone: referralCode });
            if (inviter) {
                const BONUS_AMOUNT = 50; 
                inviter.balance += BONUS_AMOUNT;
                inviter.referralBonus += BONUS_AMOUNT;
                inviter.team.push({ name: fullName, phone: phone, date: new Date().toLocaleDateString() });
                inviter.transactions.push({
                    id: "REF" + Date.now(),
                    type: "Referral Bonus",
                    amount: BONUS_AMOUNT,
                    status: "Completed",
                    date: new Date().toLocaleString()
                });
                await inviter.save();
            }
        }
        await newUser.save();
        res.status(201).json({ message: "Created" });
    } catch (err) { 
        res.status(400).json({ error: "Phone exists or data invalid" }); 
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.body.phone, password: req.body.password });
        user ? res.json(user) : res.status(401).json({ error: "Invalid login" });
    } catch (err) { res.status(500).send(); }
});

// BULLETPROOF UPDATE ROUTE (Handles PIN, Spin, and Balance)
app.post('/api/users/update', async (req, res) => {
    const { phone, balance, transactions, lastSpinDate, withdrawPin } = req.body;
    try {
        let updateData = {};
        if (balance !== undefined) updateData.balance = balance;
        if (transactions !== undefined) updateData.transactions = transactions;
        if (lastSpinDate !== undefined) updateData.lastSpinDate = lastSpinDate;
        if (withdrawPin !== undefined) updateData.withdrawPin = withdrawPin;

        const user = await User.findOneAndUpdate(
            { phone: phone },
            { $set: updateData },
            { new: true }
        );

        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Server update error" });
    }
});

app.get('/api/users/profile', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        user ? res.json(user) : res.status(404).send();
    } catch (err) { res.status(500).send(); }
});

// --- MPESA GATEWAY & WEBHOOK ---

app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;
    let formattedPhone = phone.startsWith('0') ? '254' + phone.substring(1) : phone;
    const payload = {
        api_key: "MGPYg3eI1jd2",
        amount: amount,
        msisdn: formattedPhone,
        email: "newtonmulti@gmail.com",
        callback_url: `${APP_URL}/webhook`,
        description: "Deposit",
        reference: "UI" + Date.now()
    };
    try {
        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        res.status(200).json({ status: "Sent" });
    } catch (error) { res.status(500).json({ error: "Gateway error" }); }
});

app.post('/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        const success = data.ResponseCode == 0 || data.ResultCode == 0;
        if (!success) return;
        let rawPhone = data.Msisdn || data.phone || data.PhoneNumber;
        const amount = data.TransactionAmount || data.amount || data.Amount;
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let dbPhone = rawPhone.toString();
        if (dbPhone.startsWith('254')) dbPhone = '0' + dbPhone.substring(3);
        const user = await User.findOne({ phone: dbPhone });
        if (user) {
            user.balance += parseFloat(amount);
            user.transactions.push({
                id: receipt, type: "Deposit", amount: parseFloat(amount),
                status: "Completed", date: new Date().toLocaleString()
            });
            await user.save();
        }
    } catch (err) { console.error("Webhook Error"); }
});

app.post('/api/withdraw', async (req, res) => {
    const { phone, amount } = req.body;
    const withdrawAmount = parseFloat(amount);
    try {
        const user = await User.findOneAndUpdate(
            { phone: phone, balance: { $gte: withdrawAmount } },
            { $inc: { balance: -withdrawAmount } },
            { new: true }
        );
        if (!user) return res.status(400).json({ error: "Insufficient balance" });
        const transactionId = "WID" + Date.now();
        user.transactions.push({
            id: transactionId, type: "Withdrawal", amount: withdrawAmount,
            status: "Pending", date: new Date().toLocaleString()
        });
        await user.save();
        const message = `🚀 *WITHDRAWAL REQUEST*\n👤 *User:* ${user.fullName}\n📞 *Phone:* ${phone}\n💰 *Amount:* KES ${withdrawAmount}`;
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown'
        });
        res.json({ message: "Processing..." });
    } catch (error) { res.status(500).send(); }
});

// --- ADMIN ROUTES ---

app.post('/api/admin/verify', (req, res) => {
    if (req.body.key === MASTER_KEY) res.sendStatus(200);
    else res.sendStatus(401);
});

app.get('/api/admin/users', checkAuth, async (req, res) => {
    try {
        const users = await User.find({}).sort({ balance: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: "Access Denied" }); }
});

app.post('/api/admin/adjust-balance', checkAuth, async (req, res) => {
    const { phone, newBal } = req.body;
    try {
        const user = await User.findOneAndUpdate(
            { phone },
            { $set: { balance: parseFloat(newBal) } },
            { new: true }
        );
        user.transactions.push({
            id: "SYS" + Date.now(), type: "System Adjustment", amount: parseFloat(newBal),
            status: "Completed", date: new Date().toLocaleString()
        });
        await user.save();
        res.json({ message: "Balance updated" });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/admin/mark-paid', checkAuth, async (req, res) => {
    const { phone, txId } = req.body;
    try {
        const user = await User.findOne({ phone });
        const tx = user.transactions.find(t => t.id === txId);
        if (tx) {
            tx.status = "Completed";
            user.markModified('transactions');
            await user.save();
            res.json({ message: "Paid successfully" });
        }
    } catch (err) { res.status(500).send(); }
});

app.post('/api/admin/delete-user', checkAuth, async (req, res) => {
    try {
        await User.findOneAndDelete({ phone: req.body.phone });
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).send(); }
});

const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});