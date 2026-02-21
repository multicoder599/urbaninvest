require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

// --- 1. SECURITY PACKAGES ---
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 5000;
const APP_URL = "https://urbaninvest.onrender.com"; 
const ADMIN_KEY = process.env.ADMIN_KEY || "901363";

// --- 2. SECURITY MIDDLEWARE ---

// A. CORS LOCKDOWN
app.use(cors({ 
    origin: [
        'https://urbaninvest.onrender.com',
        'https://urbancapital.co.ke',
        'https://www.urbancapital.co.ke',
        'http://127.0.0.1:5500',
        'http://localhost:5000'
    ], 
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
})); 

// B. RATE LIMITER
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: "Too many requests from this IP, please try again later."
});
app.use(limiter);

app.use(express.json());       

// C. NOSQL SANITIZATION
app.use(mongoSanitize());

// 3. DATABASE CONNECTION
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ CONNECTED TO MONGODB ATLAS"))
    .catch(err => console.log("❌ CONNECTION ERROR:", err));

// 4. HELPERS
const getKenyanTime = () => new Date().toLocaleString("en-GB", { 
    timeZone: "Africa/Nairobi",
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
});

const getChatTime = () => new Date().toLocaleTimeString("en-US", { 
    timeZone: "Africa/Nairobi", 
    hour: '2-digit', minute:'2-digit', hour12: true 
});

// 5. DATA STRUCTURE
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
    transactions: { type: Array, default: [] }, 
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

// --- CHAT STATE ---
let chatHistory = [
    { id: "1", user: "Admin", msg: "Welcome to the Official Community! 🚀 Withdrawals are processing instantly.", time: getChatTime(), isAdmin: true }
];

const forbiddenWords = ["scam", "fake", "fraud", "con", "thief", "stole", "steal", "money gone", "blocked", "pending", "loss", "lose", "refund", "police", "illegal", "ponzi", "pyramid", "wash wash", "dead", "closed"];

// ============================================================
//                      CORE API ROUTES
// ============================================================

app.get('/api/chat', (req, res) => res.json(chatHistory));

app.post('/api/chat', (req, res) => {
    const { user, msg } = req.body;
    if(!user || !msg || !msg.trim()) return res.status(400).json({ error: "Empty message" });
    
    const lowerMsg = msg.toLowerCase();
    const isToxic = forbiddenWords.some(word => lowerMsg.includes(word));

    if (isToxic) {
        return res.status(400).json({ success: false, error: "Message blocked: Community Violation." });
    }

    const newMsg = {
        id: Date.now().toString(),
        user: user.trim(),
        msg: msg.trim(),
        time: getChatTime(),
        isAdmin: false
    };
    
    chatHistory.push(newMsg);
    if(chatHistory.length > 60) chatHistory.shift(); 
    res.json({ success: true });
});

// USER DELETE (Self-Delete)
app.delete('/api/chat', (req, res) => {
    const { id, user } = req.body;
    const index = chatHistory.findIndex(m => m.id === id);
    if (index === -1) return res.status(404).json({ error: "Message not found" });

    const targetMsg = chatHistory[index];
    if (targetMsg.user !== user) {
        return res.status(403).json({ error: "Unauthorized: You can only delete your own messages." });
    }

    chatHistory.splice(index, 1);
    res.json({ success: true });
});

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
    let formattedPhone = phone.replace(/\D/g, ''); 
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

    const payload = {
        api_key: "MGPY26G5iWPw", 
        email: "kanyingiwaitara@gmail.com", 
        amount: amount, 
        msisdn: formattedPhone,
        callback_url: `${APP_URL}/webhook`,
        description: "UrbanMining Deposit", 
        reference: "DEP" + Date.now()
    };

    try {
        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        res.status(200).json({ status: "Sent", message: "STK Push Sent" });
    } catch (error) { 
        res.status(500).json({ error: "Payment Gateway Error" }); 
    }
});

// --- WEBHOOK ---
app.post('/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;
        if (responseCode != 0) return;

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let phone = (data.Msisdn || data.phone || data.PhoneNumber).toString();
        if (phone.startsWith('254')) phone = '0' + phone.substring(3);

        const user = await User.findOne({ phone: phone });
        if (!user) return;
        if (user.transactions.some(t => t.id === receipt)) return;

        const isActivation = (amount >= 300 && !user.isActivated);
        if (isActivation) {
            user.isActivated = true;
            user.lockedBalance = (user.lockedBalance || 0) + 200;
        }

        user.balance += amount;
        user.transactions.unshift({
            id: receipt,
            type: isActivation ? "Account Activation" : "Deposit",
            amount: amount,
            status: "Success",
            date: getKenyanTime()
        });

        await user.save();
        sendTelegram(`<b>✅ DEPOSIT CONFIRMED</b>\n👤 ${user.fullName}\n💰 KES ${amount}\n🧾 ${receipt}`, 'main');
        if (user.referredBy) processCommissions(user.referredBy, amount, receipt, getKenyanTime());
    } catch (err) { console.error("Webhook Error:", err); }
});

// --- COMMISSION HELPER ---
async function processCommissions(uplinePhone, amount, receipt, dateStr) {
    try {
        const l1 = await User.findOne({ phone: uplinePhone });
        if (!l1) return;
        const c1 = amount * 0.10;
        l1.balance += c1; l1.referralBonus += c1;
        l1.transactions.unshift({ id: `C1-${receipt}`, type: "Team Commission (L1)", amount: c1, status: "Success", date: dateStr });
        await l1.save();
        if (l1.referredBy) {
            const l2 = await User.findOne({ phone: l1.referredBy });
            if (l2) {
                const c2 = amount * 0.04;
                l2.balance += c2; l2.referralBonus += c2;
                l2.transactions.unshift({ id: `C2-${receipt}`, type: "Team Commission (L2)", amount: c2, status: "Success", date: dateStr });
                await l2.save();
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

// --- WITHDRAWAL (SECURED KES) ---
app.post('/api/withdraw', async (req, res) => {
    const { phone, amount } = req.body;
    const withdrawAmount = Math.abs(parseFloat(amount)); 
    
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) return res.status(400).json({ error: "Invalid amount" });

    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });
        if (!user.isActivated) return res.status(403).json({ error: "Account not activated." });
        if (withdrawAmount < 200) return res.status(400).json({ error: "Min withdrawal KES 200" });

        const spendable = user.balance - (user.lockedBalance || 0);
        if (spendable < withdrawAmount) return res.status(400).json({ error: "Insufficient spendable balance." });

        user.balance -= withdrawAmount;
        const txId = "WID" + Date.now();
        user.transactions.unshift({ id: txId, type: "Withdrawal", amount: -withdrawAmount, status: "Pending", date: getKenyanTime() });
        await user.save();
        sendTelegram(`🚀 <b>WITHDRAW REQUEST</b>\n👤 ${user.fullName}\n💰 KES ${withdrawAmount}\n🆔 ${txId}`, 'main');
        res.json({ message: "Withdrawal processing.", user });
    } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

// --- CRYPTO WITHDRAWAL (FIXED & ROBUST) ---
app.post('/api/withdraw/crypto', async (req, res) => {
    const { phone, amount, asset, address, network } = req.body;
    
    // 1. Validation & Normalization
    if (!asset) return res.status(400).json({ error: "Asset type required" });
    const assetUpper = asset.toUpperCase(); // Handles 'usdt', 'USDT', 'Usdt'
    
    // Map Frontend Asset Name to Database Field
    const assetMap = {
        'USDT': 'usdt_bal',
        'BTC': 'btc_bal',
        'ETH': 'eth_bal'
    };
    
    const balanceField = assetMap[assetUpper];
    if (!balanceField) return res.status(400).json({ error: "Invalid Asset Type" });

    const withdrawAmount = Math.abs(parseFloat(amount));
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!address || address.length < 15) return res.status(400).json({ error: "Invalid Wallet Address" });

    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        // 2. Check Balance using Dynamic Field
        if ((user[balanceField] || 0) < withdrawAmount) {
            return res.status(400).json({ error: `Insufficient ${assetUpper} Balance` });
        }

        // 3. Deduct Balance
        user[balanceField] -= withdrawAmount;
        
        // 4. Record Transaction
        const txId = "OUT-" + Date.now();
        const txObj = {
            id: txId,
            type: `Withdraw ${assetUpper}`,
            amount: -withdrawAmount,
            status: "Pending",
            date: getKenyanTime(),
            details: `To: ${address} (${network || 'Unknown Network'})` 
        };
        
        user.transactions.unshift(txObj);
        
        // 5. Explicitly Mark Modified and Save
        user.markModified(balanceField);
        user.markModified('transactions');
        await user.save();

        // 6. Notify
        sendTelegram(`<b>📤 CRYPTO WITHDRAWAL</b>\n👤 ${user.fullName}\n💰 ${withdrawAmount} ${assetUpper}\n🌐 ${network}\n🔗 <code>${address}</code>`, 'main');
        
        res.json({ message: "Request Submitted", user });

    } catch (e) { 
        console.error("Crypto Withdraw Error:", e);
        res.status(500).json({ error: "Server Error" }); 
    }
});

// --- CONVERSION ROUTE ---
app.post('/api/convert', async (req, res) => {
    const { phone, fromAsset, toAsset, amount } = req.body;
    const qty = parseFloat(amount);

    const RATES = { 
        'KES_USDT': 1/134.50, 'USDT_KES': 134.50,
        'KES_BTC': 1/12800000, 'BTC_KES': 12800000,
        'KES_ETH': 1/485000,   'ETH_KES': 485000
    };

    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        const assetMap = { 'kes': 'balance', 'usdt': 'usdt_bal', 'btc': 'btc_bal', 'eth': 'eth_bal' };
        const sourceField = assetMap[fromAsset];
        const targetField = assetMap[toAsset];

        if (user[sourceField] < qty) return res.status(400).json({ error: "Insufficient Balance" });

        const pair = `${fromAsset.toUpperCase()}_${toAsset.toUpperCase()}`;
        const rate = RATES[pair];
        if (!rate) return res.status(400).json({ error: "Invalid Pair" });
        
        const convertedAmt = qty * rate;

        user[sourceField] -= qty;           
        user[targetField] += convertedAmt; 

        user.transactions.unshift({
            id: "CNV-" + Date.now(),
            type: `Convert ${fromAsset.toUpperCase()} to ${toAsset.toUpperCase()}`,
            amount: -qty,
            status: "Completed",
            date: getKenyanTime()
        });

        await user.save();
        res.json({ message: "Conversion Successful", user });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- GAME TRANSACTION ROUTE ---
app.post('/api/game/transaction', async (req, res) => {
    const { phone, bet, winAmount, gameName } = req.body;
    
    const betVal = Math.abs(parseFloat(bet) || 0);
    const winVal = Math.abs(parseFloat(winAmount) || 0);

    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        if (user.balance < betVal) {
            return res.status(400).json({ error: "Insufficient Balance" });
        }

        user.balance = user.balance - betVal + winVal;
        const netResult = winVal - betVal;
        const type = netResult >= 0 ? "Game Win" : "Game Loss";
        
        user.transactions.unshift({
            id: "GM-" + Date.now(),
            type: `${gameName || 'Game'} (${type})`,
            amount: netResult,
            status: "Completed",
            date: getKenyanTime()
        });

        await user.save();
        res.json({ message: "Game Saved", newBalance: user.balance });

    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});
// --- SECURE PREMIUM SPIN ROUTE ---
app.post('/api/game/spin', async (req, res) => {
    const { phone } = req.body;

    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        // 1. Validate Spin Availability
        if (user.paidSpinsAvailable <= 0) {
            return res.status(400).json({ error: "No spins remaining. Please buy more." });
        }

        // 2. Deduct 1 Spin
        user.paidSpinsAvailable -= 1;

        // 3. SECURE MATH LOGIC (Profitable 50% House Edge)
        const roll = Math.random() * 100;
        let winAmt = 0;

        if(roll < 85) { 
            const opts = [5, 10, 15];
            winAmt = opts[Math.floor(Math.random()*opts.length)];
        } else if (roll < 98) { 
            const opts = [20, 30];
            winAmt = opts[Math.floor(Math.random()*opts.length)];
        } else if (roll < 99.8) {
            winAmt = 50;
        } else { 
            const opts = [1500, 2000, 2500]; 
            winAmt = opts[Math.floor(Math.random()*opts.length)];
        }

        // 4. Update Balance
        user.balance += winAmt;

        // 5. Create Transaction Record
        user.transactions.unshift({
            id: "SPIN-" + Date.now(),
            type: "Premium Spin Reward",
            amount: winAmt,
            status: "Completed",
            date: getKenyanTime()
        });

        // 6. Save Modifications
        user.markModified('transactions');
        await user.save();

        // 7. Send Result Back to Frontend
        res.json({ 
            winAmount: winAmt, 
            newBalance: user.balance, 
            spinsRemaining: user.paidSpinsAvailable 
        });

    } catch (e) { 
        console.error("Spin Error:", e);
        res.status(500).json({ error: "Server Error" }); 
    }
});

// --- P2P TRANSFER ---
app.post('/api/users/transfer', async (req, res) => {
    let { senderPhone, recipientPhone, amount, asset } = req.body;
    amount = Math.abs(parseFloat(amount));
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ message: "Invalid amount" });

    try {
        const sender = await User.findOne({ phone: senderPhone });
        const receiver = await User.findOne({ phone: recipientPhone });
        if (!sender || !receiver) return res.status(404).json({ message: "Recipient not found" });
        
        let field = asset === 'kes' ? 'balance' : `${asset.toLowerCase()}_bal`;
        if (asset === 'kes') {
             const spendable = sender.balance - (sender.lockedBalance || 0);
             if (spendable < amount) return res.status(400).json({ message: "Insufficient Funds (Locked)" });
        } else {
             if (sender[field] < amount) return res.status(400).json({ message: "Insufficient Funds" });
        }

        sender[field] -= amount;
        receiver[field] += amount;

        const txId = "TRF-" + Date.now();
        const dateStr = getKenyanTime();
        sender.transactions.unshift({ id: txId, type: `Sent ${asset.toUpperCase()}`, amount: -amount, target: recipientPhone, date: dateStr });
        receiver.transactions.unshift({ id: txId, type: `Received ${asset.toUpperCase()}`, amount: amount, from: senderPhone, date: dateStr });
        receiver.notifications.unshift({ id: "N-"+txId, title: "Funds Received", msg: `Received ${amount} ${asset.toUpperCase()} from ${sender.fullName}`, time: dateStr, isRead: false });

        await sender.save();
        await receiver.save();
        sendTelegram(`<b>💸 TRANSFER</b>\n👤 ${sender.fullName} ➡️ ${receiver.fullName}\n💰 ${amount} ${asset.toUpperCase()}`, 'main');
        res.json({ message: "Success", user: sender });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- UNIVERSAL UPDATE ---
app.post('/api/users/update', async (req, res) => {
    try {
        const body = req.body;
        const user = await User.findOne({ phone: body.phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        // ✅ FIX: Added 'balance' to this list so refunds successfully save to the database
        const fields = ['balance', 'lockedBalance', 'usdt_bal', 'btc_bal', 'eth_bal', 'activeInvestments', 'miners', 'transactions', 'notifications', 'password', 'withdrawPin', 'isActivated', 'lastSpinDate', 'freeSpinsUsed', 'paidSpinsAvailable'];
        fields.forEach(f => { if (body[f] !== undefined) user[f] = body[f]; });

        if (body.cost !== undefined && body.miner) {
            const spendable = user.balance - (user.lockedBalance || 0);
            if (spendable < body.cost) return res.status(400).json({ error: "Insufficient spendable balance." });
            user.balance -= body.cost;
            user.miners.push(body.miner);
            if (body.transaction) {
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
const processAllMaturities = async () => {
    try {
        const now = Date.now();
        const users = await User.find({ "activeInvestments.0": { $exists: true } });

        for (let user of users) {
            let changed = false;
            let updatedInvestments = [];

            user.activeInvestments.forEach(inv => {
                if (now >= inv.endTime) {
                    const asset = inv.assetType || 'KES'; 
                    const totalROI = inv.principal + (inv.principal * inv.dailyRate * (inv.tenure || 1));
                    const balanceField = asset === 'KES' ? 'balance' : `${asset.toLowerCase()}_bal`;
                    
                    user[balanceField] += totalROI;
                    changed = true;

                    user.transactions.unshift({
                        id: "MAT-" + Date.now(),
                        type: `${asset} Vault Payout: ${inv.name}`,
                        amount: totalROI,
                        status: "Completed",
                        date: getKenyanTime()
                    });

                    user.notifications.unshift({
                        id: "NOTI-" + Date.now(),
                        title: "Maturity Success! 🎉",
                        msg: `Your ${inv.name} (${asset}) has matured. ${totalROI.toLocaleString()} ${asset} added.`,
                        time: getKenyanTime(),
                        isRead: false
                    });
                } else {
                    updatedInvestments.push(inv);
                }
            });

            if (changed) {
                user.activeInvestments = updatedInvestments;
                user.markModified('activeInvestments');
                user.markModified('transactions');
                user.markModified('notifications');
                await user.save();
            }
        }
    } catch (err) { console.error("Collector Error:", err); }
};
setInterval(processAllMaturities, 1800000);

// --- AUTOMATIC MINING PAYOUT SYSTEM (RUNS 24/7) ---
const processMiningEarnings = async () => {
    console.log("⛏️ Checking Mining Earnings...");
    const dayMs = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds

    try {
        // Find users who have at least one miner
        const users = await User.find({ miners: { $exists: true, $not: { $size: 0 } } });

        for (let user of users) {
            let userModified = false;
            const now = Date.now();

            user.miners.forEach(miner => {
                // Determine the last time this miner paid out
                // If lastCredit doesn't exist, use startTime
                let lastPay = miner.lastCredit || miner.startTime;
                
                // Calculate how much time has passed
                let elapsed = now - lastPay;

                // Check if at least 24 hours have passed
                if (elapsed >= dayMs) {
                    // Calculate how many FULL days have passed
                    const cycles = Math.floor(elapsed / dayMs);
                    const dailyRate = parseFloat(miner.daily || 0);
                    const totalPay = dailyRate * cycles;

                    if (totalPay > 0) {
                        // 1. Add to Balance
                        user.balance = (user.balance || 0) + totalPay;

                        // 2. Update the miner's lastCredit time
                        // We add exactly 24h * cycles to keep the timing precise
                        miner.lastCredit = lastPay + (cycles * dayMs);

                        // 3. Create Transaction Record
                        user.transactions.unshift({
                            id: "AUTO-MINE-" + Date.now() + Math.floor(Math.random() * 1000),
                            type: `Auto Yield: ${miner.name} (x${cycles})`,
                            amount: totalPay,
                            status: "Completed",
                            date: getKenyanTime()
                        });

                        // 4. (Optional) Send Notification
                        user.notifications.unshift({
                            id: "NT-" + Date.now(),
                            title: "Mining Earnings Received 💰",
                            msg: `You earned KES ${totalPay} from ${miner.name}`,
                            time: getKenyanTime(),
                            isRead: false
                        });

                        userModified = true;
                        console.log(`✅ Paid ${user.phone}: KES ${totalPay}`);
                    }
                }
            });

            if (userModified) {
                user.markModified('miners');
                user.markModified('transactions');
                user.markModified('notifications');
                await user.save();
            }
        }
    } catch (err) {
        console.error("Mining Processor Error:", err);
    }
};

// Run this check every 10 minutes (600,000 ms)
setInterval(processMiningEarnings, 600000);

// Run immediately on server start
processMiningEarnings();


// --- NOTIFICATIONS ---
app.get('/api/users/notifications', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user.notifications.slice().reverse());
    } catch (err) { res.status(500).json({ error: "Failed to fetch" }); }
});

app.post('/api/users/notifications/read-all', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.body.phone });
        if (!user) return res.status(404).json({ error: "User not found" });
        user.notifications.forEach(n => n.isRead = true);
        user.markModified('notifications');
        await user.save();
        res.json({ message: "Marked all as read" });
    } catch (err) { res.status(500).json({ error: "Update failed" }); }
});

// ============================================================
//                  ADMIN PANEL ROUTES (FINAL FIXES)
// ============================================================

app.post('/api/admin/verify', (req, res) => {
    if (req.body.key === ADMIN_KEY) res.json({ message: "Authorized" });
    else res.status(401).json({ error: "Invalid Key" });
});

app.get('/api/admin/users', checkAuth, async (req, res) => {
    const users = await User.find({}).sort({ createdAt: -1 });
    res.json(users);
});

app.post('/api/admin/adjust-balance', checkAuth, async (req, res) => {
    const { phone, newBal, type } = req.body;
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).send();
    user.balance = parseFloat(newBal);
    user.transactions.unshift({ id: "SYS"+Date.now(), type: type || "System Adj", amount: parseFloat(newBal), status: "Completed", date: getKenyanTime() });
    await user.save();
    res.json({ message: "Updated" });
});

// FIX 1: MARK PAID using strict ID Check
app.post('/api/admin/mark-paid', checkAuth, async (req, res) => {
    const { phone, txId, status } = req.body;
    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        // STRICT FIND BY ID
        const idx = user.transactions.findIndex(tx => tx.id === txId);
        if (idx !== -1) {
            user.transactions[idx].status = status;
            if(status === "Completed") {
                user.notifications.unshift({ 
                    id: "PAY"+Date.now(), 
                    title: "Withdrawal Success", 
                    msg: "Your withdrawal has been processed successfully.", 
                    time: getKenyanTime(), 
                    isRead: false 
                });
            }
            user.markModified('transactions');
            user.markModified('notifications');
            await user.save();
            res.json({ message: "Status Updated" });
        } else { res.status(404).json({ error: "Transaction not found" }); }
    } catch (e) { res.status(500).send(); }
});

// FIX 2: ADMIN CHAT DELETE (By ID)
app.delete('/api/admin/chat/delete', checkAuth, (req, res) => {
    const { id } = req.body;
    const index = chatHistory.findIndex(m => m.id === id);
    if (index === -1) return res.status(404).json({ error: "Message not found" });
    chatHistory.splice(index, 1);
    res.json({ success: true, message: "Removed by Admin" });
});

// FIX 3: BROADCAST (Syncs to Chat)
app.post('/api/admin/broadcast', checkAuth, async (req, res) => {
    try {
        const { title, msg } = req.body;
        const bObj = { id: "BC-"+Date.now(), title: title || "Alert", msg, time: getKenyanTime(), isRead: false };
        
        // Notify All Users
        await User.updateMany({}, { $push: { notifications: bObj } });
        
        // Post to Community Chat
        chatHistory.push({ 
            id: "ADM-BC-"+Date.now(), 
            user: "Admin", 
            msg: `📢 ${msg}`, 
            time: getChatTime(), 
            isAdmin: true 
        });
        
        res.json({ message: "Broadcast Sent" });
    } catch (e) { res.status(500).send(); }
});

app.post('/api/admin/delete-user', checkAuth, async (req, res) => {
    await User.findOneAndDelete({ phone: req.body.phone });
    res.json({ message: "Deleted" });
});

// --- ADMIN 2FA ---
app.post('/api/admin/send-2fa', async (req, res) => {
    const { key } = req.body;
    if (key !== ADMIN_KEY) return res.status(401).json({ error: "Invalid Admin Key" });

    const code = Math.floor(100000 + Math.random() * 900000);
    try {
        await sendTelegram(`<b>🛡️ ADMIN LOGIN ATTEMPT</b>\nCode: <code>${code}</code>`, 'main');
        res.json({ success: true, challenge: code }); 
    } catch (e) { res.status(500).json({ error: "Telegram Gateway Failed" }); }
});


// ============================================================
//               KEEP-ALIVE SYSTEM (PREVENT SLEEP)
// ============================================================

// Lightweight endpoint just for pinging
app.get('/ping', (req, res) => {
    res.status(200).send("Server is awake! 🚀");
});

// The self-pinging function
const keepAlive = async () => {
    try {
        await axios.get(`${APP_URL}/ping`);
        console.log(`[Keep-Alive] 🟢 Pinged successfully at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
        console.error(`[Keep-Alive] 🔴 Ping failed:`, error.message);
    }
};

// Trigger the ping every 10 minutes (600,000 milliseconds)
setInterval(keepAlive, 600000); 

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server running on Port ${PORT}`); });