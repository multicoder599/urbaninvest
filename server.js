require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST'] })); 
app.use(express.json());       

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ CONNECTED TO MONGODB"))
    .catch(err => console.log("❌ CONNECTION ERROR:", err));

const User = mongoose.model('User', new mongoose.Schema({
    fullName: String,
    phone: { type: String, unique: true },
    password: String,
    balance: { type: Number, default: 0 },
    transactions: { type: Array, default: [] },
    miners: { type: Array, default: [] },
    referredBy: String,
    team: Array,
    referralBonus: { type: Number, default: 0 }
}));

// STK PUSH
app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;
    let formattedPhone = phone.startsWith('0') ? '254' + phone.substring(1) : phone;

    const payload = {
        api_key: "MGPYg3eI1jd2",
        amount: amount,
        msisdn: formattedPhone,
        email: "newtonmulti@gmail.com",
        callback_url: "https://urbaninvest.onrender.com/api/deposit/callback",
        description: "Deposit",
        reference: "UI" + Date.now()
    };

    try {
        const response = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        if (response.data.ResponseCode === '0' || response.data.success === '200') {
            return res.json({ status: "Sent" });
        }
    } catch (error) {
        console.error("STK Error:", error.message);
    }
    res.status(500).json({ error: "Failed" });
});

// CALLBACK (THE FIX)
app.post('/api/deposit/callback', async (req, res) => {
    // 1. Tell MegaPay we got it immediately so they stop the timeout
    res.status(200).send("OK");

    const data = req.body;
    console.log(">>> CALLBACK RECEIVED:", JSON.stringify(data));

    try {
        const success = data.ResponseCode == 0 || data.ResultCode == 0 || 
                        (data.ResultDesc && data.ResultDesc.toLowerCase().includes("success"));

        if (!success) return;

        let rawPhone = data.Msisdn || data.phone || data.PhoneNumber;
        let amount = data.TransactionAmount || data.amount || data.Amount;
        let receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.CheckoutRequestID;

        // Convert 254 to 0
        let dbPhone = rawPhone.toString();
        if (dbPhone.startsWith('254')) dbPhone = '0' + dbPhone.substring(3);

        console.log(`Attempting to credit ${dbPhone} with ${amount}`);

        // Update database
        const user = await User.findOne({ phone: dbPhone });
        if (user) {
            // Check if already credited
            if (user.transactions.some(t => t.id === receipt)) {
                return console.log("Already credited.");
            }

            user.balance += parseFloat(amount);
            user.transactions.push({
                id: receipt,
                type: "Deposit",
                amount: parseFloat(amount),
                date: new Date().toLocaleString()
            });

            await user.save();
            console.log("✅ Deposit Successful");
        } else {
            console.log("❌ User not found:", dbPhone);
        }
    } catch (err) {
        console.error("Callback Processing Error:", err.message);
    }
});

// OTHER ROUTES (STAY THE SAME)
app.get('/api/users/profile', async (req, res) => {
    const user = await User.findOne({ phone: req.query.phone });
    user ? res.json(user) : res.status(404).send();
});

app.post('/api/register', async (req, res) => {
    try {
        const user = new User(req.body);
        await user.save();
        res.status(201).json({ message: "Created" });
    } catch (e) { res.status(400).json({ error: "Exists" }); }
});

app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ phone: req.body.phone, password: req.body.password });
    user ? res.json(user) : res.status(401).send();
});

app.listen(process.env.PORT || 5000, '0.0.0.0');