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

// 4. STK PUSH ROUTE
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
        const response = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { timeout: 10000 });
        if (response.data.ResponseCode === '0' || response.data.success === '200') {
            return res.status(200).json({ status: "Sent" });
        } else {
            return res.status(400).json({ error: "Provider declined request" });
        }
    } catch (error) {
        res.status(500).json({ error: "Payment gateway unreachable" });
    }
});

// 5. WEBHOOK CALLBACK (Deposit)
app.post('/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    console.log(">>> WEBHOOK DATA RECEIVED:", JSON.stringify(data));

    try {
        const success = data.ResponseCode == 0 || data.ResultCode == 0 || 
            (data.ResultDesc && data.ResultDesc.toLowerCase().includes("success"));

        if (!success) return;

        let rawPhone = data.Msisdn || data.phone || data.PhoneNumber;
        const amount = data.TransactionAmount || data.amount || data.Amount;
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.CheckoutRequestID;

        let dbPhone = rawPhone.toString();
        if (dbPhone.startsWith('254')) dbPhone = '0' + dbPhone.substring(3);

        const user = await User.findOne({ phone: dbPhone });
        if (user) {
            const alreadyExists = user.transactions.some(t => t.id === receipt);
            if (alreadyExists) return;

            user.balance += parseFloat(amount);
            user.transactions.push({
                id: receipt,
                type: "Deposit",
                amount: parseFloat(amount),
                date: new Date().toLocaleString()
            });
            await user.save();
            console.log(`✅ CREDITED: ${dbPhone}`);
        }
    } catch (err) { console.error("Webhook Error:", err.message); }
});

// 🚀 6. NEW: WITHDRAWAL VIA TELEGRAM (MANUAL)
app.post('/api/withdraw', async (req, res) => {
    const { phone, amount } = req.body;
    const withdrawAmount = parseFloat(amount);
    const MIN_WITHDRAWAL = 100; // Adjust as needed

    if (withdrawAmount < MIN_WITHDRAWAL) {
        return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}` });
    }

    try {
        // Atomic check: Find user and deduct balance if they have enough
        const user = await User.findOneAndUpdate(
            { phone: phone, balance: { $gte: withdrawAmount } },
            { $inc: { balance: -withdrawAmount } },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({ error: "Insufficient balance or user not found" });
        }

        const transactionId = "WID" + Date.now();
        
        // Add pending transaction to user history
        user.transactions.push({
            id: transactionId,
            type: "Withdrawal",
            amount: withdrawAmount,
            status: "Pending",
            date: new Date().toLocaleString()
        });
        await user.save();

        // Send Notification to your Telegram
        const message = `🚀 *WITHDRAWAL REQUEST*\n\n👤 *User:* ${user.fullName}\n📞 *Phone:* ${phone}\n💰 *Amount:* KES ${withdrawAmount}\n🆔 *ID:* ${transactionId}\n\n⚠️ _Pay manually via M-Pesa Till/Paybill._`;

        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });

        res.json({ message: "Withdrawal request received and is being processed." });

    } catch (error) {
        console.error("Withdrawal Error:", error.message);
        res.status(500).json({ error: "Processing error. Please contact support." });
    }
});

// --- USER ROUTES ---

app.get('/api/users/profile', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.query.phone });
        user ? res.json(user) : res.status(404).json({ message: "Not found" });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/register', async (req, res) => {
    try {
        const newUser = new User(req.body);
        await newUser.save();
        res.status(201).json({ message: "Created" });
    } catch (err) { res.status(400).json({ error: "Phone exists" }); }
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
// ADD THIS TO YOUR server.js
app.post('/api/users/update', async (req, res) => {
    try {
        const { phone, withdrawPin } = req.body;
        const user = await User.findOne({ phone });
        
        if (!user) return res.status(404).json({ error: "User not found" });

        user.withdrawPin = withdrawPin;
        await user.save();

        res.json({ message: "Success", withdrawPin: user.withdrawPin });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});
// --- ADMIN ROUTES ---

// Get all users for admin dashboard
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({});
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

// Mark a withdrawal as Paid
app.post('/api/admin/mark-paid', async (req, res) => {
    const { phone, txId } = req.body;
    try {
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ error: "User not found" });

        // Find the transaction and update status
        const txIndex = user.transactions.findIndex(t => t.id === txId);
        if (txIndex !== -1) {
            user.transactions[txIndex].status = "Completed";
            user.markModified('transactions'); // Important for Mongoose arrays
            await user.save();
            res.json({ message: "Transaction marked as Paid" });
        } else {
            res.status(404).json({ error: "Transaction not found" });
        }
    } catch (err) {
        res.status(500).json({ error: "Update failed" });
    }
});

// Delete a user
app.post('/api/admin/delete-user', async (req, res) => {
    try {
        await User.findOneAndDelete({ phone: req.body.phone });
        res.json({ message: "User deleted" });
    } catch (err) {
        res.status(500).json({ error: "Delete failed" });
    }
});
// Update user profile (for setting PIN)
app.post('/api/users/update', async (req, res) => {
    const { phone, withdrawPin } = req.body;
    try {
        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Update the PIN
        user.withdrawPin = withdrawPin;
        await user.save();

        res.json({ message: "Profile updated successfully", withdrawPin: user.withdrawPin });
    } catch (err) {
        console.error("Update Error:", err);
        res.status(500).json({ error: "Server error while saving PIN" });
    }
});