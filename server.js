require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 5000;
const APP_URL = "https://urbaninvest.onrender.com"; // Ensure this matches your Render URL exactly (no trailing slash)
const ADMIN_KEY = process.env.ADMIN_KEY || "901363";

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

// 3. HELPER: KENYAN TIME
// This fixes the date issue (e.g., 06/02 appearing as June 2nd)
const getKenyanTime = () => new Date().toLocaleString("en-GB", { 
    timeZone: "Africa/Nairobi",
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
});

// 4. DATA STRUCTURE
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, unique: true, required: true, index: true },
    password: { type: String, required: true },
    withdrawPin: { type: String, default: "" },
    faceData: { type: Array, default: [] },
    balance: { type: Number, default: 0 }, 
    lockedBalance: { type: Number, default: 0 }, 

    // Crypto & Assets
    usdt_bal: { type: Number, default: 0 },
    btc_bal: { type: Number, default: 0 },
    eth_bal: { type: Number, default: 0 },
    activeInvestments: { type: Array, default: [] }, 

    isActivated: { type: Boolean, default: false },
    miners: { type: Array, default: [] },
    transactions: { type: Array, default: [] }, // Stores history
    notifications: { type: Array, default: [] }, 
    referredBy: { type: String, default: null },
    
    // Teams
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
        // Only send if tokens are present to prevent crashes
        if(token && chatId) {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId, text: msg, parse_mode: 'HTML'
            });
        }
    } catch (e) { 
        console.error(`Telegram Error (${type}):`, e.message); 
    }
};

// --- AUTH MIDDLEWARE ---
const checkAuth = (req, res, next) => {
    const key = req.headers['authorization'];
    if (key === ADMIN_KEY) next();
    else res.status(401).json({ error: "Unauthorized Access" });
};

// --- KEEP-ALIVE ---
setInterval(() => { axios.get(`${APP_URL}/ping`).catch(() => {}); }, 840000); 
app.get('/ping', (req, res) => res.status(200).send("Awake"));


// ============================================================
//                    CORE API ROUTES
// ============================================================

// --- REGISTRATION ---
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, phone, password, referredBy, faceData } = req.body;
        const newUser = new User({
            fullName, phone, password,
            faceData: faceData || [],
            referredBy: referredBy || null,
            balance: 0, lockedBalance: 0,
            isActivated: false,
            notifications: [{
                id: "WELCOME" + Date.now(),
                title: "Welcome to UrbanMining",
                msg: "Start your journey by activating your account with KES 300.",
                time: getKenyanTime(),
                isRead: false
            }],
            transactions: [{
                id: "REG" + Date.now(),
                type: "Account Created",
                amount: 0,
                status: "Pending Activation",
                date: getKenyanTime()
            }]
        });

        // Handle Referral Tree
        if (referredBy) {
            const parentL1 = await User.findOne({ phone: referredBy });
            if (parentL1) {
                parentL1.team.push({ name: fullName, phone: phone, date: getKenyanTime() });
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
    } catch (err) { res.status(400).json({ error: "Registration failed or User exists" }); }
});

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.body.phone, password: req.body.password });
        user ? res.json(user) : res.status(401).json({ error: "Invalid login credentials" });
    } catch (err) { res.status(500).send(); }
});

// --- GET PROFILE ---
app.get('/api/users/profile', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        user ? res.json(user) : res.status(404).send();
    } catch (err) { res.status(500).send(); }
});

// --- STK PUSH (DEPOSIT) ---
app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;
    
    // Strict Phone Sanitization (Remove +, spaces, ensure 254)
    let formattedPhone = phone.replace(/\D/g, ''); 
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

    const payload = {
        api_key: "MGPY26G5iWPw", // REPLACE WITH YOUR REAL KEY
        email: "kanyingiwaitara@gmail.com", 
        amount: amount, 
        msisdn: formattedPhone,
        callback_url: `${APP_URL}/webhook`, // Points to the /webhook route below
        description: "UrbanMining Deposit", 
        reference: "DEP" + Date.now()
    };

    try {
        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        res.status(200).json({ status: "Sent", message: "STK Push Sent" });
    } catch (error) { 
        console.error("Gateway Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Payment Gateway Error. Try Manual Paybill." }); 
    }
});

// --- WEBHOOK (INSTANT DEPOSIT) ---
app.post('/webhook', async (req, res) => {
    res.status(200).send("OK"); // Ack immediately

    const data = req.body;
    try {
        // 1. Check Success Code
        const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;
        if (responseCode != 0) return;

        // 2. Extract Data
        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let phone = (data.Msisdn || data.phone || data.PhoneNumber).toString();

        // 3. Normalize Phone
        if (phone.startsWith('254')) phone = '0' + phone.substring(3);

        const user = await User.findOne({ phone: phone });
        if (!user) return;

        // 4. Prevent Duplicates
        const isDuplicate = user.transactions.some(t => t.id === receipt);
        if (isDuplicate) return;

        // 5. Activation Logic
        const isActivation = (amount >= 300 && !user.isActivated);
        if (isActivation) {
            user.isActivated = true;
            user.lockedBalance = (user.lockedBalance || 0) + 200;
        }

        // 6. Credit & Record (UNSHIFT = Newest First)
        user.balance += amount;
        user.transactions.unshift({
            id: receipt,
            type: isActivation ? "Account Activation" : "Deposit",
            amount: amount,
            status: "Success",
            date: getKenyanTime()
        });

        // 7. Save User FIRST
        await user.save();

        // 8. Notifications
        sendTelegram(`<b>✅ DEPOSIT CONFIRMED</b>\n👤 ${user.fullName}\n💰 KES ${amount}\n🧾 ${receipt}`, 'main');
        
        // 9. Commissions (Background)
        if (user.referredBy) processCommissions(user.referredBy, amount, receipt, getKenyanTime());

    } catch (err) {
        console.error("Webhook Error:", err);
    }
});

// --- COMMISSION HELPER ---
async function processCommissions(uplinePhone, amount, receipt, dateStr) {
    try {
        // Level 1 (10%)
        const l1 = await User.findOne({ phone: uplinePhone });
        if (!l1) return;
        const c1 = amount * 0.10;
        l1.balance += c1; l1.referralBonus += c1;
        l1.transactions.unshift({ id: `C1-${receipt}`, type: "Team Commission (L1)", amount: c1, status: "Success", date: dateStr });
        await l1.save();

        // Level 2 (4%)
        if (l1.referredBy) {
            const l2 = await User.findOne({ phone: l1.referredBy });
            if (l2) {
                const c2 = amount * 0.04;
                l2.balance += c2; l2.referralBonus += c2;
                l2.transactions.unshift({ id: `C2-${receipt}`, type: "Team Commission (L2)", amount: c2, status: "Success", date: dateStr });
                await l2.save();

                // Level 3 (1%)
                if (l2.referredBy) {
                    const l3 = await User.findOne({ phone: l2.referredBy });
                    if (l3) {
                        const c3 = amount * 0.01;
                        l3.balance += c3; l3.referralBonus += c3;
                        l3.transactions.unshift({ id: `C3-${receipt}`, type: "Team Commission (L3)", amount: c3, status: "Success", date: dateStr });
                        await l3.save();
                    }
                }
            }
        }
    } catch (err) { console.error("Commission Error:", err); }
}

// --- WITHDRAWAL ---
app.post('/api/withdraw', async (req, res) => {
    const { phone, amount } = req.body;
    const withdrawAmount = parseFloat(amount);
    
    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });
        if (!user.isActivated) return res.status(403).json({ error: "Account not activated." });
        if (withdrawAmount < 200) return res.status(400).json({ error: "Minimum withdrawal is KES 200" });

        const spendable = user.balance - (user.lockedBalance || 0);
        if (spendable < withdrawAmount) return res.status(400).json({ error: "Insufficient spendable balance." });

        user.balance -= withdrawAmount;
        const txId = "WID" + Date.now();
        
        user.transactions.unshift({ 
            id: txId, 
            type: "Withdrawal", 
            amount: -withdrawAmount, 
            status: "Pending", 
            date: getKenyanTime() 
        });

        await user.save();
        sendTelegram(`🚀 <b>WITHDRAW REQUEST</b>\n👤 ${user.fullName}\n💰 KES ${withdrawAmount}\n🆔 ${txId}`, 'main');
        res.json({ message: "Withdrawal processing.", user });

    } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

// --- P2P TRANSFER ---
app.post('/api/users/transfer', async (req, res) => {
    const { senderPhone, recipientPhone, amount, asset } = req.body;
    try {
        const sender = await User.findOne({ phone: senderPhone });
        const receiver = await User.findOne({ phone: recipientPhone });

        if (!sender || !receiver) return res.status(404).json({ message: "Recipient not found" });
        
        let field = asset === 'kes' ? 'balance' : `${asset.toLowerCase()}_bal`;
        // Check locked balance only if sending KES
        if (asset === 'kes') {
             const spendable = sender.balance - (sender.lockedBalance || 0);
             if (spendable < amount) return res.status(400).json({ message: "Insufficient Funds (Locked Balance)" });
        } else {
             if (sender[field] < amount) return res.status(400).json({ message: "Insufficient Funds" });
        }

        sender[field] -= amount;
        receiver[field] += amount;

        const txId = "TRF-" + Date.now();
        const dateStr = getKenyanTime();

        sender.transactions.unshift({ id: txId, type: `Sent ${asset.toUpperCase()}`, amount: -amount, target: recipientPhone, date: dateStr });
        receiver.transactions.unshift({ id: txId, type: `Received ${asset.toUpperCase()}`, amount: amount, from: senderPhone, date: dateStr });
        
        receiver.notifications.unshift({ 
            id: "N-"+txId, title: "Funds Received", 
            msg: `Received ${amount} ${asset.toUpperCase()} from ${sender.fullName}`, 
            time: dateStr, isRead: false 
        });

        await sender.save();
        await receiver.save();

        sendTelegram(`<b>💸 TRANSFER</b>\n👤 ${sender.fullName} ➡️ ${receiver.fullName}\n💰 ${amount} ${asset.toUpperCase()}`, 'main');
        res.json({ message: "Success", user: sender });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- UNIVERSAL UPDATE (Mining/Investments) ---
app.post('/api/users/update', async (req, res) => {
    try {
        const body = req.body;
        const user = await User.findOne({ phone: body.phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        const fields = ['balance', 'lockedBalance', 'usdt_bal', 'btc_bal', 'eth_bal', 'activeInvestments', 'miners', 'transactions', 'notifications', 'password', 'withdrawPin', 'isActivated', 'lastSpinDate', 'freeSpinsUsed', 'paidSpinsAvailable'];
        
        fields.forEach(f => {
            if (body[f] !== undefined) user[f] = body[f];
        });

        if (body.cost !== undefined && body.miner) {
            const spendable = user.balance - (user.lockedBalance || 0);
            if (spendable < body.cost) return res.status(400).json({ error: "Insufficient spendable balance." });
            
            user.balance -= body.cost;
            user.miners.push(body.miner); // Miners array can be standard push
            if (body.transaction) {
                 // Ensure date is Kenyan
                 body.transaction.date = getKenyanTime();
                 user.transactions.unshift(body.transaction);
            }
            sendTelegram(`<b>⛏️ NODE ACTIVATED</b>\n👤 ${user.fullName}\n📦 ${body.miner.name}\n💰 KES ${body.cost}`, 'main');
        } 

        user.markModified('miners');
        user.markModified('activeInvestments');
        user.markModified('transactions');
        user.markModified('notifications');
        await user.save();
        res.json({ message: "Success", user });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MATURITY COLLECTOR ---
const processMaturedInvestments = async () => {
    try {
        const now = Date.now();
        const users = await User.find({ "activeInvestments.0": { $exists: true } });

        for (let user of users) {
            let maturedFound = false;
            let updatedInvestments = [];

            user.activeInvestments.forEach(inv => {
                if (now >= inv.endTime) {
                    const totalROI = inv.principal + (inv.principal * inv.dailyRate * inv.tenure);
                    user.balance += totalROI;
                    maturedFound = true;

                    user.transactions.unshift({
                        id: "MAT-" + Date.now(),
                        type: `Vault Payout: ${inv.name}`,
                        amount: totalROI,
                        status: "Completed",
                        date: getKenyanTime()
                    });

                    user.notifications.unshift({
                        id: "NOTI-" + Date.now(),
                        title: "Investment Matured! 🎉",
                        msg: `Your ${inv.name} vault has matured. KES ${totalROI.toLocaleString()} added.`,
                        time: getKenyanTime(),
                        isRead: false
                    });
                } else {
                    updatedInvestments.push(inv);
                }
            });

            if (maturedFound) {
                user.activeInvestments = updatedInvestments;
                user.markModified('activeInvestments');
                user.markModified('transactions');
                user.markModified('notifications');
                await user.save();
            }
        }
    } catch (err) { console.error("Collector Error:", err); }
};
setInterval(processMaturedInvestments, 1800000); // Check every 30 mins

// --- ADMIN ROUTES ---
app.post('/api/admin/verify', (req, res) => {
    if (req.body.key === ADMIN_KEY) res.status(200).json({ message: "Authorized" });
    else res.status(401).json({ error: "Invalid Key" });
});

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
        user.transactions.unshift({ 
            id: "SYS"+Date.now(), 
            type: type || "System Adj", 
            amount: parseFloat(newBal), 
            status: "Completed", 
            date: getKenyanTime() 
        });
        await user.save();
        res.json({ message: "Updated" });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/admin/mark-paid', checkAuth, async (req, res) => {
    const { phone, txId, status } = req.body;
    try {
        const user = await User.findOne({ phone });
        // Use loose check for flexibility
        const txIndex = user.transactions.findIndex(tx => tx.id === txId || tx.date === txId);
        
        if (txIndex !== -1) {
            user.transactions[txIndex].status = status;
            
            if(status === "Completed") {
                user.notifications.unshift({
                    id: "PAY" + Date.now(),
                    title: "Withdrawal Successful",
                    msg: `Your withdrawal request has been processed successfully.`,
                    time: getKenyanTime(),
                    isRead: false
                });
            }
            user.markModified('transactions');
            user.markModified('notifications');
            await user.save();
        }
        res.json({ message: "Done" });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/admin/delete-user', checkAuth, async (req, res) => {
    try {
        await User.findOneAndDelete({ phone: req.body.phone });
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).send(); }
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server running on port ${PORT}`); });