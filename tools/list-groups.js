const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('ready', () => {
    console.log('✅ Client Ready!');
    console.log('====================================================');
    console.log('📱 දැන් ඔයාගේ ෆෝන් එකෙන් අර අලුත් Groups දෙකට (Test Rep / Test Main)');
    console.log('   "Hi" කියලා සාමාන්‍ය මැසේජ් එකක් යවන්න.');
    console.log('එතකොට Bot ඒ ගෲප් එකේ ID එක මෙතන පෙන්නයි!');
    console.log('====================================================');
});

// මැසේජ් එකක් ආපු ගමන් ඒකේ ID එක ගන්නවා
client.on('message', (msg) => {
    // ගෲප් එකකින් එන මැසේජ් වල අගට @g.us තියෙනවා
    if (msg.from.includes('@g.us')) {
        console.log(`\n✅ අලුත් මැසේජ් එකක් ගෲප් එකකින් ආවා!`);
        console.log(`➡️ Group ID: ${msg.from}`);
        console.log(`(මේ ID එක Copy කරගෙන .env එකට දාන්න)\n`);
    }
});

client.initialize();