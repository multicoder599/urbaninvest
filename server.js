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

// 4. STK PUSH ROUTE (Updated Callback URL)
app.post('/api/deposit/stk', async (req, res) => {
    let { phone, amount } = req.body;

    let formattedPhone = phone;
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
    }

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
        // Primary endpoint for MegaPay
        const response = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { timeout: 10000 });
        
        if (response.data.ResponseCode === '0' || response.data.success === '200') {
            return res.status(200).json({ status: "Sent" });
        } else {
            return res.status(400).json({ error: "Provider declined request" });
        }
    } catch (error) {
        console.error("STK Error:", error.message);
        res.status(500).json({ error: "Payment gateway unreachable" });
    }
});

// 5. WEBHOOK CALLBACK (The Fix)
app.post('/webhook', async (req, res) => {
    // 🔥 STEP 1: IMMEDIATELY tell MegaPay we received the data.
    // This stops the "60-second loading" on their end.
    res.status(200).send("OK");

    const data = req.body;
    console.log(">>> WEBHOOK DATA RECEIVED:", JSON.stringify(data));

    try {
        // STEP 2: Verify Success
        const success =
            data.ResponseCode == 0 ||
            data.ResultCode == 0 ||
            (data.ResultDesc && data.ResultDesc.toLowerCase().includes("success")) ||
            (data.ResponseDescription && data.ResponseDescription.toLowerCase().includes("success"));

        if (!success) return console.log("❌ Payment failed according to callback");

        // STEP 3: Extract Data
        let rawPhone = data.Msisdn || data.phone || data.PhoneNumber;
        const amount = data.TransactionAmount || data.amount || data.Amount;
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.transaction_id || data.CheckoutRequestID;

        if (!rawPhone || !amount) return console.log("❌ Incomplete data in webhook");

        // Convert 254... to 0...
        let dbPhone = rawPhone.toString();
        if (dbPhone.startsWith('254')) {
            dbPhone = '0' + dbPhone.substring(3);
        }

        // STEP 4: Credit the User
        const user = await User.findOne({ phone: dbPhone });

        if (user) {
            // Prevent double crediting same receipt
            const alreadyExists = user.transactions.some(t => t.id === receipt);
            if (alreadyExists) return console.log("⚠️ Transaction already processed");

            const depositVal = parseFloat(amount);
            user.balance = (user.balance || 0) + depositVal;
            user.transactions.push({
                id: receipt || "MP" + Date.now(),
                type: "Deposit",
                amount: depositVal,
                date: new Date().toLocaleString()
            });

            await user.save();
            console.log(`✅ SUCCESSFULLY CREDITED: ${dbPhone} with KES ${depositVal}`);
        } else {
            console.log(`❌ User NOT FOUND in database: ${dbPhone}`);
        }
    } catch (err) {
        console.error("🔥 WEBHOOK PROCESSING ERROR:", err.message);
    }
});

// --- REST OF YOUR ROUTES ---

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