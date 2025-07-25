const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const app = express();

// توكن البوت من Secrets
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('❌ يرجى إضافة TELEGRAM_BOT_TOKEN في Secrets');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const MIN_AMOUNT = 0.05;

// روابط RPC
const API_URLS = [
    process.env.RPC_URL,
    process.env.RPC_URL2,
    process.env.RPC_URL3,
    process.env.RPC_URL4,
    process.env.RPC_URL5,
    process.env.RPC_URL6
].filter(url => url);

if (API_URLS.length === 0) {
    console.error('❌ يرجى إضافة روابط RPC في Secrets (RPC_URL, RPC_URL2, إلخ...)');
    process.exit(1);
}

// تحليل التحويلات
async function fetchTransfers(toAddress, chatId, messageId) {
    console.log('🔍 جاري البحث عن جميع المعاملات...');
    const url = API_URLS[0];
    let allSignatures = [];
    let before = null;
    let pageNumber = 1;

    await bot.editMessageText(
        `🔍 جاري البحث عن المعاملات...\n📋 العنوان: ${toAddress.substring(0, 20)}...\n💰 الحد الأدنى: ${MIN_AMOUNT} SOL\n📄 جلب الصفحة ${pageNumber}...`,
        { chat_id: chatId, message_id: messageId }
    );

    while (true) {
        const params = [toAddress, { limit: 1000 }];
        if (before) params[1].before = before;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params
            })
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(`API Error: ${data.error.message}`);
        if (!data.result || data.result.length === 0) break;

        allSignatures.push(...data.result);

        await bot.editMessageText(
            `🔍 جاري البحث...\n📋 ${toAddress.substring(0, 20)}...\n📄 الصفحة ${pageNumber}\n📊 التوقيعات: ${allSignatures.length}`,
            { chat_id: chatId, message_id: messageId }
        );

        if (data.result.length < 1000) break;
        before = data.result[data.result.length - 1].signature;
        pageNumber++;
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    await bot.editMessageText(
        `✅ تم جمع التوقيعات بنجاح!\n📊 التوقيعات: ${allSignatures.length}\n🔄 جاري التحليل...`,
        { chat_id: chatId, message_id: messageId }
    );

    if (allSignatures.length === 0) return [];

    const transactions = [];
    const batchSize = 2000;
    const batches = [];

    for (let i = 0; i < allSignatures.length; i += batchSize) {
        batches.push(allSignatures.slice(i, i + batchSize));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const progress = ((batchIndex + 1) / batches.length * 100).toFixed(1);

        await bot.editMessageText(
            `🔄 تحليل المعاملات...\n📈 ${progress}%`,
            { chat_id: chatId, message_id: messageId }
        );

        const batchPromises = batch.map(async (sig, index) => {
            const maxRetries = 3;
            let retryCount = 0;

            while (retryCount < maxRetries) {
                try {
                    const apiUrl = API_URLS[index % API_URLS.length];
                    const txResponse = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'getTransaction',
                            params: [sig.signature, { encoding: 'jsonParsed' }]
                        })
                    });

                    if (!txResponse.ok) throw new Error(`HTTP ${txResponse.status}`);
                    const responseText = await txResponse.text();
                    if (responseText.includes('<!DOCTYPE')) throw new Error('Rate limited');
                    const txData = JSON.parse(responseText);
                    if (txData.error) throw new Error(`API Error: ${txData.error.message}`);
                    return txData.result;

                } catch (error) {
                    retryCount++;
                    if (retryCount >= maxRetries) return null;
                    await new Promise(resolve => setTimeout(resolve, 200 * Math.pow(2, retryCount - 1)));
                }
            }

            return null;
        });

        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(result => { if (result) transactions.push(result); });
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return transactions;
}

function extractValidSenders(transactions, toAddress) {
    const senderCount = {};
    const senderTransactions = {};
    let validTransfersFound = 0;

    for (const tx of transactions) {
        if (!tx?.transaction?.message?.instructions) continue;

        for (const instruction of tx.transaction.message.instructions) {
            if (instruction.program === 'system' && instruction.parsed?.type === 'transfer') {
                const info = instruction.parsed.info;
                const amountSOL = info.lamports / 1e9;

                if (info.destination === toAddress && info.source && amountSOL >= MIN_AMOUNT) {
                    const sender = info.source;
                    senderCount[sender] = (senderCount[sender] || 0) + 1;
                    if (!senderTransactions[sender]) senderTransactions[sender] = [];
                    senderTransactions[sender].push({
                        signature: tx.transaction.signatures[0],
                        amount: amountSOL,
                        blockTime: tx.blockTime
                    });
                    validTransfersFound++;
                }
            }
        }
    }

    const allSenders = Object.entries(senderCount)
        .map(([address, count]) => ({
            address,
            count,
            transactions: senderTransactions[address],
            totalAmount: senderTransactions[address].reduce((sum, tx) => sum + tx.amount, 0)
        }))
        .sort((a, b) => b.totalAmount - a.totalAmount);

    return { allSenders, totalValidTransfers: validTransfersFound };
}

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `🚀 أهلاً بك! أرسل عنوان محفظة سولانا للتحليل.\n💰 الحد الأدنى: ${MIN_AMOUNT} SOL`);
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `ℹ️ أرسل عنوان محفظة لتحليل المرسلين.\n📊 يظهر أكثر من أرسلوا أكثر من ${MIN_AMOUNT} SOL\n\n/start - بدء\n/help - تعليمات`);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();

    if (text.startsWith('/')) return;
    if (!text || text.length < 40 || text.length > 50) {
        return bot.sendMessage(chatId, `❌ عنوان غير صحيح!\nأرسل عنوان سولانا صحيح.`);
    }

    try {
        const startMsg = await bot.sendMessage(chatId, `🚀 بدء التحليل...\n📋 ${text.substring(0, 20)}...`);
        const transactions = await fetchTransfers(text, chatId, startMsg.message_id);

        if (transactions.length === 0) {
            return bot.editMessageText(`❌ لا توجد معاملات لهذا العنوان`, {
                chat_id: chatId, message_id: startMsg.message_id
            });
        }

        const results = extractValidSenders(transactions, text);
        let finalMessage = `✅ تحليل كامل\n\n📈 ${results.allSenders.length} عنوان أرسلوا أكثر من ${MIN_AMOUNT} SOL:\n`;

        results.allSenders.forEach((s, i) => {
            finalMessage += `${i + 1}. \`${s.address}\`\n`;
        });

        finalMessage += `\n📊 إجمالي التحويلات الصالحة: ${results.totalValidTransfers}`;

        await bot.editMessageText(finalMessage, {
            chat_id: chatId, message_id: startMsg.message_id, parse_mode: 'Markdown'
        });

    } catch (err) {
        console.error('❌ خطأ:', err);
        bot.sendMessage(chatId, `❌ حصل خطأ:\n${err.message}`);
    }
});

// ✅ خادم Express للمراقبة (لتعمل على Render)
const PORT = process.env.PORT || 5000;
app.get(['/health', '/'], (req, res) => {
    res.json({
        status: 'online',
        message: 'Telegram Bot is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});
app.listen(PORT, () => {
    console.log(`🌐 خادم المراقبة يعمل على المنفذ ${PORT}`);
    console.log(`🔗 رابط المراقبة: http://localhost:${PORT}/health`);
});

console.log('🤖 بوت تلجرام جاهز للعمل!');
console.log('🔑 تأكد من إضافة TELEGRAM_BOT_TOKEN في Secrets');
