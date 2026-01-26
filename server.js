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
    balance: { type: Number, default: 0 }, 
    isActivated: { type: Boolean, default: false }, // New logic
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
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// --- TELEGRAM HELPER ---
const sendTelegram = async (msg, type = 'main') => {
    try {
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

// --- KEEP-ALIVE ---
const APP_URL = `https://urbaninvest.onrender.com`; 
setInterval(() => { axios.get(`${APP_URL}/ping`).catch(() => {}); }, 840000); 
app.get('/ping', (req, res) => res.status(200).send("Awake"));

// --- REGISTRATION (Full Referral Logic) ---
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, phone, password, referredBy, faceData } = req.body;

        const newUser = new User({
            fullName, phone, password,
            faceData: faceData || [],
            referredBy: referredBy || null,
            balance: 0,
            isActivated: false,
            transactions: [{
                id: "REG" + Date.now(),
                type: "Account Created",
                amount: 0,
                status: "Pending Activation",
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
        sendTelegram(`<b>🆕 NEW REGISTRATION</b>\n👤 ${fullName}\n📞 ${phone}\n🔗 Ref: ${referredBy || 'Direct'}`, 'user');
        res.status(201).json({ message: "Created", user: newUser });
    } catch (err) { res.status(400).json({ error: "Registration failed" }); }
});

// --- AUTH ---
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

// --- UNIVERSAL UPDATE (Liquidation & Security) ---
app.post('/api/users/update', async (req, res) => {
    try {
        const { phone, balance, miners, transactions, cost, miner, transaction, password, withdrawPin, isActivated } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        if (cost !== undefined && miner) {
            if (user.balance < cost) return res.status(400).json({ error: "Insufficient balance" });
            user.balance -= cost;
            user.miners.push(miner);
            if (transaction) user.transactions.push(transaction);
            sendTelegram(`<b>⛏️ NODE ACTIVATED</b>\n👤 ${user.fullName}\n📦 ${miner.name}\n💰 KES ${cost}`, 'main');
        } else {
            if (balance !== undefined) user.balance = balance;
            if (miners !== undefined) user.miners = miners;
            if (transactions !== undefined) user.transactions = transactions;
            if (password !== undefined) user.password = password;
            if (withdrawPin !== undefined) user.withdrawPin = withdrawPin;
            if (isActivated !== undefined) user.isActivated = isActivated;
        }

        user.markModified('miners');
        user.markModified('transactions');
        await user.save();
        res.json({ message: "Success", user });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- WEBHOOK (Deposits & 3-Level Commissions) ---
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
            const activating = (amount >= 300 && !user.isActivated);
            if (activating) user.isActivated = true;

            user.balance += amount;
            user.transactions.push({
                id: receipt, type: activating ? "Activation Fee" : "Deposit", amount: amount,
                status: "Completed", date: new Date().toLocaleString()
            });
            user.markModified('transactions');
            await user.save();

            // 3-LEVEL COMMISSIONS
            if (user.referredBy) {
                const l1 = await User.findOne({ phone: user.referredBy });
                if (l1) {
                    const c1 = amount * 0.10;
                    l1.balance += c1; l1.referralBonus += c1;
                    l1.transactions.push({ id: "C1-"+receipt, type: "Team Commission", amount: c1, status: "Completed", date: new Date().toLocaleString() });
                    await l1.save();

                    if (l1.referredBy) {
                        const l2 = await User.findOne({ phone: l1.referredBy });
                        if (l2) {
                            const c2 = amount * 0.04;
                            l2.balance += c2; l2.referralBonus += c2;
                            l2.transactions.push({ id: "C2-"+receipt, type: "L2 Commission", amount: c2, status: "Completed", date: new Date().toLocaleString() });
                            await l2.save();

                            if (l2.referredBy) {
                                const l3 = await User.findOne({ phone: l2.referredBy });
                                if (l3) {
                                    const c3 = amount * 0.01;
                                    l3.balance += c3; l3.referralBonus += c3;
                                    l3.transactions.push({ id: "C3-"+receipt, type: "L3 Commission", amount: c3, status: "Completed", date: new Date().toLocaleString() });
                                    await l3.save();
                                }
                            }
                        }
                    }
                }
            }
            sendTelegram(`<b>✅ PAYMENT</b>\n👤 ${user.fullName}\n💰 KES ${amount}\n${activating ? '⭐ ACTIVATED' : '💳 DEPOSIT'}`, 'main');
        }
    } catch (err) { console.error("Webhook Error", err); }
});

// --- WITHDRAWAL (Min 500 / Flat 30 Fee) ---
app.post('/api/withdraw', async (req, res) => {
    const { phone, amount } = req.body;
    const withdrawAmount = parseFloat(amount);
    const flatFee = 30;

    try {
        const user = await User.findOne({ phone });
        if (!user || !user.isActivated) return res.status(403).json({ error: "Activate account first" });
        if (withdrawAmount < 500) return res.status(400).json({ error: "Min withdrawal KES 500" });
        if (user.balance < withdrawAmount) return res.status(400).json({ error: "Insufficient balance" });
        
        user.balance -= withdrawAmount;
        const txId = "WID" + Date.now();
        user.transactions.push({ id: txId, type: "Withdrawal", amount: withdrawAmount, status: "Pending", date: new Date().toLocaleString() });
        
        user.markModified('transactions');
        await user.save();
        
        sendTelegram(`🚀 <b>WITHDRAWAL</b>\n👤 ${user.fullName}\n📞 ${phone}\n💰 KES ${withdrawAmount}\n💸 Net: KES ${withdrawAmount - flatFee}`, 'main');
        res.json({ message: "Processing..." });
    } catch (error) { res.status(500).send(); }
});

// --- STK PUSH ---
app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;
    let formattedPhone = phone.startsWith('0') ? '254' + phone.substring(1) : phone;
    const payload = {
        api_key: "MGPY26G5iWPw", amount: amount, msisdn: formattedPhone,
        email: "kanyingiwaitara@gmail.com", callback_url: `${APP_URL}/webhook`,
        description: "UrbanMining Payment", reference: "ACT" + Date.now()
    };
    try {
        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        res.status(200).json({ status: "Sent" });
    } catch (error) { res.status(500).json({ error: "Gateway error" }); }
});

// --- ADMIN: GRANDFATHER OLD USERS (DISABLED AFTER USE) ---
// app.get('/api/admin/grandfather-users', checkAuth, async (req, res) => {
//     try {
//         await User.updateMany({}, { $set: { isActivated: true } });
//         res.send("Success: All existing users are now activated.");
//     } catch (err) { res.status(500).send("Error updating users."); }
// });

app.post('/api/admin/verify', (req, res) => {
    const { key } = req.body;
    if (key === MASTER_KEY) {
        res.status(200).json({ message: "Authorized" });
    } else {
        res.status(401).json({ error: "Invalid Key" });
    }
});
// --- ADMIN: OTHER ROUTES ---
app.get('/api/admin/users', checkAuth, async (req, res) => {
    try {
        const users = await User.find({}).sort({ createdAt: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: "Denied" }); }
});

app.post('/api/admin/adjust-balance', checkAuth, async (req, res) => {
    const { phone, newBal, type } = req.body;
    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).send();
        user.balance = parseFloat(newBal);
        user.transactions.push({ id: "SYS"+Date.now(), type: type || "System Adj", amount: parseFloat(newBal), status: "Completed", date: new Date().toLocaleString() });
        await user.save();
        res.json({ message: "Updated" });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/admin/mark-paid', checkAuth, async (req, res) => {
    const { phone, txId, status } = req.body;
    try {
        const user = await User.findOne({ phone });
        user.transactions = user.transactions.map(tx => {
            if (tx.id === txId || tx.date === txId) tx.status = status;
            return tx;
        });
        user.markModified('transactions');
        await user.save();
        res.json({ message: "Done" });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/admin/delete-user', checkAuth, async (req, res) => {
    try {
        await User.findOneAndDelete({ phone: req.body.phone });
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).send(); }
});

const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server on port ${PORT}`); });