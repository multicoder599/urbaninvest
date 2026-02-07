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
    lockedBalance: { type: Number, default: 0 }, 

    // --- INSERTION POINT: CRYPTO & PORTFOLIO FIELDS ---
    usdt_bal: { type: Number, default: 0 },
    btc_bal: { type: Number, default: 0 },
    eth_bal: { type: Number, default: 0 },
    activeInvestments: { type: Array, default: [] }, 
    // --------------------------------------------------

    isActivated: { type: Boolean, default: false },
    miners: { type: Array, default: [] },
    transactions: { type: Array, default: [] },
    notifications: { type: Array, default: [] }, 
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

// --- REGISTRATION ---
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, phone, password, referredBy, faceData } = req.body;
        const newUser = new User({
            fullName, phone, password,
            faceData: faceData || [],
            referredBy: referredBy || null,
            balance: 0,
            lockedBalance: 0,
            isActivated: false,
            notifications: [{
                id: "WELCOME" + Date.now(),
                title: "Welcome to UrbanMining",
                msg: "Start your journey by activating your account with KES 300.",
                time: new Date().toLocaleDateString(),
                isRead: false
            }],
            transactions: [{
                id: "REG" + Date.now(),
                type: "Account Created",
                amount: 0,
                status: "Pending Activation",
                date: new Date().toLocaleString()
            }]
        });

        if (referredBy) {
            // 1. Level 1 Update
            const parentL1 = await User.findOne({ phone: referredBy });
            if (parentL1) {
                parentL1.team.push({ name: fullName, phone: phone, date: new Date().toLocaleDateString() });
                await parentL1.save();
        
                // 2. Level 2 Update
                if (parentL1.referredBy) {
                    const parentL2 = await User.findOne({ phone: parentL1.referredBy });
                    if (parentL2) {
                        parentL2.teamL2.push({ name: fullName, phone: phone, from: parentL1.fullName });
                        await parentL2.save();
        
                        // 3. Level 3 Update
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

// --- INSERTION POINT: GET USER BY PHONE ---
app.get('/api/users/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        user ? res.json(user) : res.status(404).json({ error: "User not found" });
    } catch (err) { res.status(500).send(); }
});
// ------------------------------------------

app.get('/api/users/profile', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        user ? res.json(user) : res.status(404).send();
    } catch (err) { res.status(500).send(); }
});

// --- NOTIFICATION RETRIEVAL ---
app.get('/api/users/notifications', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user.notifications.reverse()); 
    } catch (err) { res.status(500).send(); }
});

app.post('/api/users/notifications/read', async (req, res) => {
    try {
        const { phone, notiId } = req.body;
        const user = await User.findOne({ phone });
        user.notifications = user.notifications.map(n => {
            if (n.id === notiId) n.isRead = true;
            return n;
        });
        user.markModified('notifications');
        await user.save();
        res.json({ message: "Read" });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/users/notifications/read-all', async (req, res) => {
    try {
        const { phone } = req.body;
        const user = await User.findOne({ phone });
        user.notifications = user.notifications.map(n => {
            n.isRead = true;
            return n;
        });
        user.markModified('notifications');
        await user.save();
        res.json({ message: "All Read" });
    } catch (err) { res.status(500).send(); }
});

// --- INSERTION POINT: INTERNAL P2P TRANSFERS ---
app.post('/api/users/transfer', async (req, res) => {
    const { senderPhone, recipientPhone, amount, asset } = req.body;
    try {
        const sender = await User.findOne({ phone: senderPhone });
        const receiver = await User.findOne({ phone: recipientPhone });

        if (!sender || !receiver) return res.status(404).json({ message: "Recipient not found" });
        
        let field = asset === 'kes' ? 'balance' : `${asset.toLowerCase()}_bal`;
        if (sender[field] < amount) return res.status(400).json({ message: "Insufficient Funds" });

        sender[field] -= amount;
        receiver[field] += amount;

        const txId = "TRF-" + Date.now();
        sender.transactions.unshift({ id: txId, type: `Sent ${asset.toUpperCase()}`, amount: -amount, target: recipientPhone, date: new Date().toLocaleString() });
        receiver.transactions.unshift({ id: txId, type: `Received ${asset.toUpperCase()}`, amount: amount, from: senderPhone, date: new Date().toLocaleString() });
        
        receiver.notifications.unshift({ id: "N-"+txId, title: "Funds Received", msg: `Received ${amount} ${asset.toUpperCase()} from ${sender.fullName}`, time: new Date().toLocaleTimeString(), isRead: false });

        sender.markModified('transactions');
        receiver.markModified('transactions');
        receiver.markModified('notifications');

        await sender.save();
        await receiver.save();

        sendTelegram(`<b>💸 TRANSFER</b>\n👤 ${sender.fullName} ➡️ ${receiver.fullName}\n💰 ${amount} ${asset.toUpperCase()}`, 'main');
        res.json({ message: "Success", user: sender });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// ----------------------------------------------

// --- UNIVERSAL UPDATE ---
app.post('/api/users/update', async (req, res) => {
    try {
        const body = req.body;
        const user = await User.findOne({ phone: body.phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        // --- INSERTION: SMART FIELD UPDATES ---
        const fields = ['balance', 'lockedBalance', 'usdt_bal', 'btc_bal', 'eth_bal', 'activeInvestments', 'miners', 'transactions', 'notifications', 'password', 'withdrawPin', 'isActivated', 'lastSpinDate', 'freeSpinsUsed', 'paidSpinsAvailable'];
        
        fields.forEach(f => {
            if (body[f] !== undefined) user[f] = body[f];
        });
        // --------------------------------------

        if (body.cost !== undefined && body.miner) {
            const spendable = user.balance - (user.lockedBalance || 0);
            if (spendable < body.cost) return res.status(400).json({ error: "Insufficient spendable balance. KES 200 must remain locked." });
            
            user.balance -= body.cost;
            user.miners.push(body.miner);
            if (body.transaction) user.transactions.push(body.transaction);
            sendTelegram(`<b>⛏️ NODE ACTIVATED</b>\n👤 ${user.fullName}\n📦 ${body.miner.name}\n💰 KES ${body.cost}`, 'main');
        } 

        user.markModified('miners');
        user.markModified('activeInvestments'); // Track Vaults
        user.markModified('transactions');
        user.markModified('notifications');
        await user.save();
        res.json({ message: "Success", user });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- INSERTION POINT: AUTO-MATURITY COLLECTOR ---
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
                        date: new Date().toLocaleString()
                    });

                    user.notifications.unshift({
                        id: "NOTI-" + Date.now(),
                        title: "Investment Matured! 🎉",
                        msg: `Your ${inv.name} vault has matured. KES ${totalROI.toLocaleString()} added.`,
                        time: new Date().toLocaleTimeString(),
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
                console.log(`✅ Payout for ${user.fullName}`);
            }
        }
    } catch (err) { console.error("Collector Error:", err); }
};
setInterval(processMaturedInvestments, 1800000); // 30 mins
// ------------------------------------------------

// --- WEBHOOK (Deposits & Locked Balance Logic) ---
app.post('/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        const success = data.ResponseCode == 0 || data.ResultCode == 0;
        if (!success) return;
        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let dbPhone = (data.Msisdn || data.phone || data.PhoneNumber).toString();
        if (dbPhone.startsWith('254')) dbPhone = '0' + dbPhone.substring(3);

        const user = await User.findOne({ phone: dbPhone });
        if (user) {
            const activating = (amount >= 300 && !user.isActivated);
            if (activating) {
                user.isActivated = true;
                user.lockedBalance = 200; 
            }

            user.balance += amount;
            user.transactions.push({
                id: receipt, 
                type: activating ? "Account Activation" : "Deposit", 
                amount: amount,
                status: "Completed", 
                date: new Date().toLocaleString()
            });

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
            user.markModified('transactions');
            await user.save();
            sendTelegram(`<b>✅ PAYMENT</b>\n👤 ${user.fullName}\n💰 KES ${amount}\n${activating ? '⭐ ACTIVATED' : '💳 DEPOSIT'}`, 'main');
        }
    } catch (err) { console.error("Webhook Error", err); }
});

// --- WITHDRAWAL (Updated Min KES 200 & Locked Safety Check) ---
app.post('/api/withdraw', async (req, res) => {
    const { phone, amount } = req.body;
    const withdrawAmount = parseFloat(amount);
    const flatFee = 30; // Standard processing fee

    try {
        const user = await User.findOne({ phone });
        
        // 1. Activation Check
        if (!user || !user.isActivated) {
            return res.status(403).json({ error: "Account not activated. Please pay KES 300 activation fee." });
        }
        
        // 2. Spendable Balance Calculation (Balance minus the KES 200 Locked Reserve)
        const spendable = user.balance - (user.lockedBalance || 0);
        
        // 3. Updated Minimum Limit Check
        if (withdrawAmount < 200) {
            return res.status(400).json({ error: "Minimum withdrawal limit is KES 200" });
        }
        
        // 4. Sufficient Funds Check
        if (spendable < withdrawAmount) {
            return res.status(400).json({ error: "Insufficient spendable balance. KES 200 activation reserve must remain in account." });
        }
        
        // 5. Execute Deduction
        user.balance -= withdrawAmount;
        const txId = "WID" + Date.now();
        
        // Add to Transaction History (Unshift puts it at the top)
        user.transactions.unshift({ 
            id: txId, 
            type: "Withdrawal", 
            amount: withdrawAmount, 
            status: "Pending", 
            date: new Date().toLocaleString() 
        });
        
        // 6. Save to Database
        user.markModified('transactions');
        await user.save();
        
        // 7. Admin Notification (Telegram)
        const netAmount = withdrawAmount - flatFee;
        sendTelegram(
            `🚀 <b>WITHDRAWAL REQUEST</b>\n` +
            `👤 Name: ${user.fullName}\n` +
            `📞 Phone: ${phone}\n` +
            `💰 Gross: KES ${withdrawAmount}\n` +
            `💸 Net Payout: <b>KES ${netAmount}</b>\n` +
            `🆔 TX: ${txId}`, 
            'main'
        );
        
        res.json({ message: "Withdrawal request received. Funds will be sent to your M-Pesa shortly.", user });

    } catch (error) { 
        console.error("Withdrawal Route Error:", error);
        res.status(500).json({ error: "Internal server error. Please try again." }); 
    }
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

// --- ADMIN ROUTES ---
app.post('/api/admin/verify', (req, res) => {
    const { key } = req.body;
    if (key === MASTER_KEY) res.status(200).json({ message: "Authorized" });
    else res.status(401).json({ error: "Invalid Key" });
});

app.get('/api/admin/users', checkAuth, async (req, res) => {
    try {
        const users = await User.find({}).sort({ createdAt: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: "Denied" }); }
});

// ADMIN: Individual Notification
app.post('/api/admin/send-notification', checkAuth, async (req, res) => {
    try {
        const { phone, title, msg, time, id } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        user.notifications.push({ id, title, msg, time, isRead: false });
        user.markModified('notifications');
        await user.save();
        res.json({ message: "Sent" });
    } catch (err) { res.status(500).send(); }
});

// ADMIN: Global Broadcast
app.post('/api/admin/broadcast-notification', checkAuth, async (req, res) => {
    try {
        const { title, msg, time, id } = req.body;
        await User.updateMany({}, {
            $push: { notifications: { id, title, msg, time, isRead: false } }
        });
        res.json({ message: "Broadcast Complete" });
    } catch (err) { res.status(500).send(); }
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
        
        if(status === "Completed") {
            user.notifications.push({
                id: "PAY" + Date.now(),
                title: "Withdrawal Successful",
                msg: `Your withdrawal request has been processed successfully.`,
                time: new Date().toLocaleTimeString(),
                isRead: false
            });
        }

        user.markModified('transactions');
        user.markModified('notifications');
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

// --- INSERTION POINT: ADMIN FORCE COLLECT ---
app.post('/api/admin/force-collect', checkAuth, async (req, res) => {
    await processMaturedInvestments();
    res.json({ message: "Maturity check completed manually." });
});
// ---------------------------------------------

const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server on port ${PORT}`); });