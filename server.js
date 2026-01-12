require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();

// 1. MIDDLEWARE
app.use(cors({ origin: '*', methods: ['GET', 'POST'] })); 
app.use(express.json());       

// 2. DATABASE CONNECTION
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ CONNECTED TO MONGODB ATLAS"))
    .catch(err => console.log("❌ CONNECTION ERROR:", err));

// 3. THE DATA STRUCTURE (Updated with withdrawPin)
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    withdrawPin: { type: String, default: "" }, // Added this
    faceData: { type: Array, default: [] },
    balance: { type: Number, default: 0 },
    miners: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    referredBy: { type: String, default: null },
    team: { type: Array, default: [] },
    referralBonus: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// --- AUTH & REFERRAL SYSTEM ---

app.post('/api/register', async (req, res) => {
    try {
        const { fullName, phone, password, referralCode } = req.body;
        
        // 1. Create the new user
        const newUser = new User({
            fullName,
            phone,
            password,
            referredBy: referralCode || null
        });

        // 2. REFERRAL SYSTEM: Check if someone invited this user
        if (referralCode) {
            const inviter = await User.findOne({ phone: referralCode });
            if (inviter) {
                const BONUS_AMOUNT = 50; // Set your bonus here (e.g. KES 50)
                
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
                console.log(`🎁 Referral bonus sent to ${inviter.phone}`);
            }
        }

        await newUser.save();
        res.status(201).json({ message: "Created" });
    } catch (err) { 
        res.status(400).json({ error: "Phone exists or data invalid" }); 
    }
});

// --- SECURITY & PROFILE UPDATES ---

// Handles both PIN and Password updates
app.post('/api/users/update', async (req, res) => {
    const { phone, withdrawPin, password } = req.body;
    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        if (withdrawPin) user.withdrawPin = withdrawPin;
        if (password) user.password = password;

        await user.save();
        res.json({ message: "Updated successfully", user });
    } catch (err) {
        res.status(500).json({ error: "Update failed" });
    }
});

// --- DEPOSIT & WITHDRAWAL ---

app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;
    let formattedPhone = phone.startsWith('0') ? '254' + phone.substring(1) : phone;

    const payload = {
        api_key: "MGPYg3eI1jd2",
        amount: amount,
        msisdn: formattedPhone,
        email: "newtonmulti@gmail.com",
        callback_url: "https://urbaninvest.onrender.com/webhook",
        description: "Deposit",
        reference: "UI" + Date.now()
    };

    try {
        const response = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        res.status(200).json({ status: "Sent" });
    } catch (error) {
        res.status(500).json({ error: "Gateway error" });
    }
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
                id: receipt,
                type: "Deposit",
                amount: parseFloat(amount),
                status: "Completed",
                date: new Date().toLocaleString()
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
            id: transactionId,
            type: "Withdrawal",
            amount: withdrawAmount,
            status: "Pending",
            date: new Date().toLocaleString()
        });
        await user.save();

        const message = `🚀 *WITHDRAWAL REQUEST*\n👤 *User:* ${user.fullName}\n📞 *Phone:* ${phone}\n💰 *Amount:* KES ${withdrawAmount}`;
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });

        res.json({ message: "Processing..." });
    } catch (error) { res.status(500).send(); }
});

app.get('/api/users/profile', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        user ? res.json(user) : res.status(404).send();
    } catch (err) { res.status(500).send(); }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.body.phone, password: req.body.password });
        user ? res.json(user) : res.status(401).json({ error: "Invalid login" });
    } catch (err) { res.status(500).send(); }
});

const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});