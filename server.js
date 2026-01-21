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

// 3. DATA STRUCTURE
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, unique: true, required: true, index: true },
    password: { type: String, required: true },
    withdrawPin: { type: String, default: "" },
    faceData: { type: Array, default: [] },
    balance: { type: Number, default: 50 }, 
    miners: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    referredBy: { type: String, default: null },
    team: { type: Array, default: [] },    
    teamL2: { type: Array, default: [] },  
    teamL3: { type: Array, default: [] },  
    referralBonus: { type: Number, default: 0 },
    lastSpinDate: { type: Date, default: null },
    freeSpinsUsed: { type: Number, default: 0 },
    paidSpinsAvailable: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// --- FLEXIBLE TELEGRAM HELPER (Dual Bot Support) ---
const sendTelegram = async (msg, type = 'main') => {
    try {
        // Choose credentials based on type
        const token = type === 'user' ? process.env.USER_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN;
        const chatId = type === 'user' ? process.env.USER_CHAT_ID : process.env.TELEGRAM_CHAT_ID;

        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: msg,
            parse_mode: 'HTML'
        });
    } catch (e) { 
        console.error(`Telegram Error (${type}):`, e.response?.data || e.message); 
    }
};

// --- ADMIN SECURITY ---
const MASTER_KEY = process.env.ADMIN_KEY || "901363"; 
const checkAuth = (req, res, next) => {
    const key = req.headers['authorization'];
    if (key === MASTER_KEY) next();
    else res.status(401).json({ error: "Unauthorized Access" });
};

// --- RENDER KEEP-ALIVE ---
const APP_URL = `https://urbaninvest.onrender.com`; 
setInterval(() => {
    axios.get(`${APP_URL}/ping`).catch(() => {});
}, 840000); 

app.get('/ping', (req, res) => res.status(200).send("Awake"));

// --- REGISTRATION WITH SECOND BOT NOTIFICATION ---
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, phone, password, referredBy, faceData } = req.body;

        const newUser = new User({
            fullName, phone, password,
            faceData: faceData || [],
            referredBy: referredBy || null,
            balance: 50, 
            transactions: [{
                id: "WELCOME" + Date.now(),
                type: "Signup Bonus",
                amount: 50,
                status: "Completed",
                date: new Date().toLocaleString()
            }]
        });

        if (referredBy) {
            const parentL1 = await User.findOne({ phone: referredBy });
            if (parentL1) {
                parentL1.team.push({ name: fullName, phone: phone, date: new Date().toLocaleDateString() });
                await parentL1.save();

                if (parentL1.referredBy) {
                    const parentL2 = await User.findOne({ phone: parentL1.referredBy });
                    if (parentL2) {
                        parentL2.teamL2.push({ name: fullName, phone: phone, from: parentL1.fullName });
                        await parentL2.save();

                        if (parentL2.referredBy) {
                            const parentL3 = await User.findOne({ phone: parentL2.referredBy });
                            if (parentL3) {
                                parentL3.teamL3.push({ name: fullName, phone: phone, from: parentL2.fullName });
                                await parentL3.save();
                            }
                        }
                    }
                }
            }
        }

        await newUser.save();
        
        // Notify the USER BOT
        sendTelegram(
            `<b>🆕 NEW USER REGISTERED</b>\n👤 ${fullName}\n📞 ${phone}\n🔗 Ref By: ${referredBy || 'Direct'}`, 
            'user' 
        );

        res.status(201).json({ message: "Created", user: newUser });
        
    } catch (err) { 
        res.status(400).json({ error: "Phone exists or data invalid" }); 
    }
});

// --- AUTH & PROFILE ---
app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.body.phone, password: req.body.password });
        user ? res.json(user) : res.status(401).json({ error: "Invalid login" });
    } catch (err) { res.status(500).send(); }
});

app.get('/api/users/profile', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        user ? res.json(user) : res.status(404).send();
    } catch (err) { res.status(500).send(); }
});

app.post('/api/users/update', async (req, res) => {
    try {
        const user = await User.findOneAndUpdate(
            { phone: req.body.phone },
            { $set: req.body },
            { new: true }
        );
        res.json(user);
    } catch (err) { res.status(500).json({ error: "Update failed" }); }
});

// --- WEBHOOK WITH MAIN BOT NOTIFICATION ---
app.post('/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        const success = data.ResponseCode == 0 || data.ResultCode == 0;
        if (!success) return;
        
        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let rawPhone = data.Msisdn || data.phone || data.PhoneNumber;
        let dbPhone = rawPhone.toString();
        if (dbPhone.startsWith('254')) dbPhone = '0' + dbPhone.substring(3);

        const user = await User.findOne({ phone: dbPhone });
        if (user) {
            user.balance += amount;
            user.transactions.push({
                id: receipt, type: "Deposit", amount: amount,
                status: "Completed", date: new Date().toLocaleString()
            });
            await user.save();

            // Pay Commissions (L1: 10%, L2: 4%, L3: 1%)
            if (user.referredBy) {
                const l1 = await User.findOne({ phone: user.referredBy });
                if (l1) {
                    const comm = amount * 0.10;
                    l1.balance += comm; l1.referralBonus += comm;
                    l1.transactions.push({ id: "COMM"+receipt, type: "L1 Commission", amount: comm, status: "Completed", date: new Date().toLocaleString() });
                    await l1.save();

                    if (l1.referredBy) {
                        const l2 = await User.findOne({ phone: l1.referredBy });
                        if (l2) {
                            const comm2 = amount * 0.04;
                            l2.balance += comm2; l2.referralBonus += comm2;
                            l2.transactions.push({ id: "COMM2"+receipt, type: "L2 Commission", amount: comm2, status: "Completed", date: new Date().toLocaleString() });
                            await l2.save();

                            if (l2.referredBy) {
                                const l3 = await User.findOne({ phone: l2.referredBy });
                                if (l3) {
                                    const comm3 = amount * 0.01;
                                    l3.balance += comm3; l3.referralBonus += comm3;
                                    l3.transactions.push({ id: "COMM3"+receipt, type: "L3 Commission", amount: comm3, status: "Completed", date: new Date().toLocaleString() });
                                    await l3.save();
                                }
                            }
                        }
                    }
                }
            }
            
            // Notify the MAIN BOT
            sendTelegram(`<b>✅ DEPOSIT SUCCESS</b>\n👤 ${user.fullName}\n💰 KES ${amount}\n📄 ${receipt}`, 'main');
        }
    } catch (err) { console.error("Webhook Error", err); }
});

app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;
    let formattedPhone = phone.startsWith('0') ? '254' + phone.substring(1) : phone;
    const payload = {
        api_key: "MGPY26G5iWPw", 
        amount: amount,
        msisdn: formattedPhone,
        email: "kanyingiwaitara@gmail.com",
        callback_url: `${APP_URL}/webhook`,
        description: "UrbanMining Deposit",
        reference: "UI" + Date.now()
    };
    try {
        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        res.status(200).json({ status: "Sent" });
    } catch (error) { res.status(500).json({ error: "Gateway error" }); }
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
        
        const txId = "WID" + Date.now();
        user.transactions.push({ id: txId, type: "Withdrawal", amount: withdrawAmount, status: "Pending", date: new Date().toLocaleString() });
        await user.save();
        
        // Notify the MAIN BOT
        sendTelegram(`🚀 <b>WITHDRAWAL REQUEST</b>\n👤 ${user.fullName}\n📞 ${phone}\n💰 KES ${withdrawAmount}`, 'main');
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
    const { phone, newBal, type } = req.body;
    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).send();
        user.balance = parseFloat(newBal);
        user.transactions.push({ id: "SYS" + Date.now(), type: type || "System Adjustment", amount: parseFloat(newBal), status: "Completed", date: new Date().toLocaleString() });
        await user.save();
        res.json({ message: "Balance updated" });
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