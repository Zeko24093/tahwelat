
const TelegramBot = require('node-telegram-bot-api');

// تأكد من إضافة توكن البوت في Secrets
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('❌ يرجى إضافة TELEGRAM_BOT_TOKEN في Secrets');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// إعداد APIs
const MIN_AMOUNT = 0.05;

// جلب روابط RPC من Secrets
const API_URLS = [
    process.env.RPC_URL,
    process.env.RPC_URL2,
    process.env.RPC_URL3,
    process.env.RPC_URL4,
    process.env.RPC_URL5,
    process.env.RPC_URL6
].filter(url => url); // إزالة الروابط الفارغة

// التحقق من وجود روابط RPC
if (API_URLS.length === 0) {
    console.error('❌ يرجى إضافة روابط RPC في Secrets (RPC_URL, RPC_URL2, إلخ...)');
    process.exit(1);
}

// احضر كل التحويلات إلى العنوان باستخدام pagination
async function fetchTransfers(toAddress, chatId, messageId) {
    console.log('🔍 جاري البحث عن جميع المعاملات...');
    const url = API_URLS[0];
    
    let allSignatures = [];
    let before = null;
    let pageNumber = 1;
    
    // تحديث الرسالة الأولى
    await bot.editMessageText(
        `🔍 جاري البحث عن المعاملات...\n\n📋 العنوان: ${toAddress.substring(0, 20)}...\n💰 الحد الأدنى: ${MIN_AMOUNT} SOL\n\n📄 جلب الصفحة ${pageNumber}...`,
        { chat_id: chatId, message_id: messageId }
    );
    
    // جلب جميع التوقيعات باستخدام pagination
    while (true) {
        const params = [toAddress, { limit: 1000 }];
        if (before) {
            params[1].before = before;
        }
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: params
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        const data = await response.json();
        
        if (data.error) {
            throw new Error(`API Error: ${data.error.message}`);
        }
        
        if (!data.result || data.result.length === 0) {
            break;
        }
        
        allSignatures.push(...data.result);
        
        // تحديث الرسالة مع تقدم جلب الصفحات
        await bot.editMessageText(
            `🔍 جاري البحث عن المعاملات...\n\n📋 العنوان: ${toAddress.substring(0, 20)}...\n💰 الحد الأدنى: ${MIN_AMOUNT} SOL\n\n📄 تم جلب ${pageNumber} صفحة\n📊 إجمالي التوقيعات: ${allSignatures.length}`,
            { chat_id: chatId, message_id: messageId }
        );
        
        // إذا كانت النتائج أقل من 1000، فهذه آخر صفحة
        if (data.result.length < 1000) {
            break;
        }
        
        before = data.result[data.result.length - 1].signature;
        pageNumber++;
        
        // تأخير بين الصفحات
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // تحديث الرسالة مع العدد النهائي
    await bot.editMessageText(
        `✅ تم جمع التوقيعات بنجاح!\n\n📊 إجمالي التوقيعات: ${allSignatures.length}\n\n🔄 جاري تحليل المعاملات...`,
        { chat_id: chatId, message_id: messageId }
    );
    
    if (allSignatures.length === 0) {
        return [];
    }
    
    // احضر تفاصيل كل معاملة
    const transactions = [];
    const totalToProcess = allSignatures.length;
    
    // معالجة المعاملات بالتوازي
    const batchSize = 2000;
    const batches = [];
    
    for (let i = 0; i < totalToProcess; i += batchSize) {
        const batch = allSignatures.slice(i, i + batchSize);
        batches.push(batch);
    }
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const progress = ((batchIndex + 1) / batches.length * 100).toFixed(1);
        
        // تحديث الرسالة مع تقدم المعالجة
        await bot.editMessageText(
            `🔄 جاري تحليل المعاملات...\n\n📊 المجموعة ${batchIndex + 1}/${batches.length} (${progress}%)\n📈 تم معالجة: ${batchIndex * batchSize} من ${totalToProcess}`,
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
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'getTransaction',
                            params: [sig.signature, { encoding: 'jsonParsed' }]
                        })
                    });
                    
                    if (!txResponse.ok) {
                        throw new Error(`HTTP ${txResponse.status}`);
                    }
                    
                    const responseText = await txResponse.text();
                    
                    if (responseText.includes('<!DOCTYPE')) {
                        throw new Error('Rate limited');
                    }
                    
                    const txData = JSON.parse(responseText);
                    
                    if (txData.error) {
                        throw new Error(`API Error: ${txData.error.message}`);
                    }
                    
                    return txData.result;
                    
                } catch (error) {
                    retryCount++;
                    
                    if (retryCount >= maxRetries) {
                        return null;
                    }
                    
                    const delayMs = 200 * Math.pow(2, retryCount - 1);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
            
            return null;
        });
        
        const batchResults = await Promise.all(batchPromises);
        
        batchResults.forEach(result => {
            if (result) {
                transactions.push(result);
            }
        });
        
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    return transactions;
}

// تحليل التحويلات
function extractValidSenders(transactions, toAddress) {
    const senderCount = {};
    const senderTransactions = {};
    let validTransfersFound = 0;

    for (const tx of transactions) {
        if (!tx?.transaction?.message?.instructions) continue;

        for (const instruction of tx.transaction.message.instructions) {
            if (instruction.program === 'system' && instruction.parsed?.type === 'transfer') {
                const info = instruction.parsed.info;
                const amountSOL = info.lamports / 1000000000;
                
                if (
                    info.destination === toAddress &&
                    info.source &&
                    info.lamports >= MIN_AMOUNT * 1000000000
                ) {
                    const sender = info.source;
                    senderCount[sender] = (senderCount[sender] || 0) + 1;
                    
                    if (!senderTransactions[sender]) {
                        senderTransactions[sender] = [];
                    }
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

// معالجة الأوامر
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        `🚀 مرحباً بك في بوت تحليل عناوين سولانا!\n\n` +
        `📝 لبدء التحليل، أرسل عنوان المحفظة التي تريد تحليلها.\n\n` +
        `مثال:\n5Sc8Bj39pQi4Sqopm3CaLPNNSxFTshDS9KxoC3LnCDgP\n\n` +
        `💰 الحد الأدنى للتحليل: ${MIN_AMOUNT} SOL`
    );
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        `ℹ️ مساعدة البوت:\n\n` +
        `🔍 أرسل عنوان محفظة سولانا لتحليل المرسلين إليها\n` +
        `💰 يعرض العناوين التي أرسلت أكثر من ${MIN_AMOUNT} SOL\n` +
        `📊 يظهر التقدم في الوقت الفعلي\n\n` +
        `الأوامر:\n` +
        `/start - بدء استخدام البوت\n` +
        `/help - عرض هذه المساعدة`
    );
});

// معالجة العناوين المرسلة
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // تجاهل الأوامر
    if (text.startsWith('/')) {
        return;
    }
    
    // فحص صحة العنوان (طول عنوان سولانا عادة 44 حرف)
    if (!text || text.length < 40 || text.length > 50) {
        bot.sendMessage(chatId, 
            `❌ عنوان غير صحيح!\n\n` +
            `يرجى إرسال عنوان محفظة سولانا صحيح.\n` +
            `مثال: 5Sc8Bj39pQi4Sqopm3CaLPNNSxFTshDS9KxoC3LnCDgP`
        );
        return;
    }
    
    const address = text.trim();
    
    try {
        // إرسال رسالة البداية
        const startMsg = await bot.sendMessage(chatId, 
            `🚀 بدء تحليل العنوان...\n\n📋 العنوان: ${address.substring(0, 20)}...\n\n⏳ جاري التحضير...`
        );
        
        // جلب البيانات
        const transactions = await fetchTransfers(address, chatId, startMsg.message_id);
        
        if (transactions.length === 0) {
            await bot.editMessageText(
                `❌ لم يتم العثور على معاملات للتحليل!\n\n📋 العنوان: ${address.substring(0, 20)}...`,
                { chat_id: chatId, message_id: startMsg.message_id }
            );
            return;
        }
        
        // تحديث الرسالة لبدء تحليل المرسلين
        await bot.editMessageText(
            `🔍 جاري تحليل المرسلين...\n\n📊 تم جلب ${transactions.length} معاملة\n⏳ جاري البحث عن المرسلين...`,
            { chat_id: chatId, message_id: startMsg.message_id }
        );
        
        const results = extractValidSenders(transactions, address);
        
        // تحضير النتيجة النهائية
        let finalMessage = `✅ تم الانتهاء من التحليل!\n\n`;
        finalMessage += `📊 العناوين المرسلة:\n`;
        finalMessage += `━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (results.allSenders.length === 0) {
            finalMessage += `❌ لم يتم العثور على أي مرسلين`;
        } else {
            finalMessage += `📈 تم العثور على ${results.allSenders.length} عنوان:\n\n`;
            
            results.allSenders.forEach((sender, index) => {
                finalMessage += `${index + 1}. \`${sender.address}\`\n`;
            });
            
            finalMessage += `\n📊 إجمالي التحويلات الصالحة: ${results.totalValidTransfers}`;
        }
        
        // تحديث الرسالة بالنتيجة النهائية
        await bot.editMessageText(finalMessage, {
            chat_id: chatId,
            message_id: startMsg.message_id,
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        console.error('خطأ في التحليل:', error);
        bot.sendMessage(chatId, 
            `❌ حدث خطأ أثناء التحليل:\n${error.message}\n\n🔄 يرجى المحاولة مرة أخرى`
        );
    }
});

console.log('🤖 بوت تلجرام جاهز للعمل!');
console.log('🔑 تأكد من إضافة TELEGRAM_BOT_TOKEN في Secrets');
