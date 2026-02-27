// index.js - Bot Discord para API Coin com Slash Commands
// Bot completo com sistema de carteiras, pagamentos e logs

// ===================== CONFIGURAÇÕES =====================
const dotenv = require('dotenv');
dotenv.config();

// Dependências principais
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { REST, Routes } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

// ===================== CONFIGURAÇÕES VIA ENV =====================
const CONFIG = {
    // Bot
    BOT_TOKEN: process.env.BOT_TOKEN || '',
    BOT_CLIENT_ID: process.env.BOT_CLIENT_ID || '',
    BOT_PREFIX: process.env.BOT_PREFIX || '/',
    
    // API
    API_URL: process.env.API_URL || 'https://bank.foxsrv.net',
    API_TIMEOUT: parseInt(process.env.API_TIMEOUT || '30000'),
    
    // Fila de processamento
    QUEUE_DELAY_MS: parseInt(process.env.QUEUE_DELAY_MS || '1010'),
    QUEUE_MAX_CONCURRENT: parseInt(process.env.QUEUE_MAX_CONCURRENT || '1'),
    
    // Banco de dados
    DB_PATH: process.env.DB_PATH || './test.db',
    
    // Economia
    CURRENCY_SYMBOL: process.env.CURRENCY_SYMBOL || 'R$',
    COIN_DECIMALS: 8,
    DOLLAR_DECIMALS: 2,
    WITHDRAW_FEE: parseFloat(process.env.WITHDRAW_FEE || '0.01'), // 1% de taxa
    
    // Arquivos
    ICON_PATH: path.join(__dirname, 'icon.png')
};

// ===================== VALIDAÇÕES INICIAIS =====================
if (!CONFIG.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN não configurado no arquivo .env');
    process.exit(1);
}

if (!CONFIG.BOT_CLIENT_ID) {
    console.error('❌ BOT_CLIENT_ID não configurado no arquivo .env');
    process.exit(1);
}

// ===================== CLIENT DISCORD =====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ===================== BANCO DE DADOS =====================
let db;

/**
 * Inicializa o banco de dados SQLite e cria as tabelas necessárias
 */
async function initDatabase() {
    db = await open({
        filename: CONFIG.DB_PATH,
        driver: sqlite3.Database
    });

    // Tabela de configurações por servidor
    await db.exec(`
        CREATE TABLE IF NOT EXISTS guild_config (
            guild_id TEXT PRIMARY KEY,
            server_card_id TEXT,
            log_channel_id TEXT,
            staff_role_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Tabela de usuários (carteiras em reais/dólar)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT,
            guild_id TEXT,
            card_id TEXT,
            dollars REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, guild_id)
        )
    `);

    // Tabela de transações para log local
    await db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT,
            user_id TEXT,
            type TEXT,
            amount REAL,
            coin_amount REAL,
            tx_id TEXT,
            status TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Tabela da fila de processamento
    await db.exec(`
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT,
            user_id TEXT,
            type TEXT,
            payload TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            processed_at DATETIME
        )
    `);

    console.log('✅ Banco de dados inicializado com sucesso');
}

// ===================== FILA DE PROCESSAMENTO =====================
/**
 * Gerencia a fila de pagamentos para respeitar o rate limit da API
 */
class PaymentQueue {
    constructor() {
        this.isProcessing = false;
        this.queue = [];
        this.delayMs = CONFIG.QUEUE_DELAY_MS;
    }

    /**
     * Adiciona um item à fila
     * @param {Object} item - Item a ser processado
     * @returns {string} ID do item na fila
     */
    async add(item) {
        item.id = crypto.randomUUID();
        item.createdAt = Date.now();
        item.status = 'pending';
        this.queue.push(item);
        
        // Salva no banco para persistência
        await db.run(
            'INSERT INTO queue (guild_id, user_id, type, payload, status) VALUES (?, ?, ?, ?, ?)',
            [item.guildId, item.userId, item.type, JSON.stringify(item.payload), 'pending']
        );
        
        if (!this.isProcessing) {
            this.process();
        }
        return item.id;
    }

    /**
     * Processa a fila sequencialmente
     */
    async process() {
        if (this.isProcessing || this.queue.length === 0) return;
        
        this.isProcessing = true;
        
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            
            try {
                // Atualiza status no banco
                await db.run(
                    'UPDATE queue SET status = ? WHERE id = ?',
                    ['processing', item.id]
                );
                
                // Processa o item
                const result = await this.processItem(item);
                
                // Atualiza como concluído
                await db.run(
                    'UPDATE queue SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?',
                    ['completed', item.id]
                );
                
                // Chama o callback de sucesso se existir
                if (item.onSuccess) {
                    await item.onSuccess(result);
                }
                
            } catch (error) {
                console.error(`❌ Erro processando item ${item.id}:`, error);
                
                await db.run(
                    'UPDATE queue SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?',
                    ['failed', item.id]
                );
                
                if (item.onError) {
                    await item.onError(error);
                }
            }
            
            // Delay entre requisições para respeitar o rate limit
            await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }
        
        this.isProcessing = false;
    }

    /**
     * Processa um item específico baseado no tipo
     * @param {Object} item - Item a ser processado
     * @returns {Object} Resultado do processamento
     */
    async processItem(item) {
        switch (item.type) {
            case 'card_to_id':
                return await this.transferCardToId(item.payload);
            case 'card_to_card':
                return await this.transferCardToCard(item.payload);
            default:
                throw new Error(`Tipo de operação desconhecido: ${item.type}`);
        }
    }

    /**
     * Transferência de cartão para ID de usuário (endpoint: /api/transfer/card)
     * @param {Object} payload - Dados da transferência
     * @returns {Object} Resultado da API
     */
    async transferCardToId(payload) {
        const response = await axios.post(
            `${CONFIG.API_URL}/api/transfer/card`,
            {
                cardCode: payload.fromCard,
                toId: payload.toId,
                amount: this.formatCoinAmount(payload.amount)
            },
            { timeout: CONFIG.API_TIMEOUT }
        );
        
        if (!response.data || !response.data.success) {
            throw new Error(response.data?.error || 'Falha na transferência');
        }
        
        return {
            success: true,
            txId: response.data.txId,
            date: response.data.date
        };
    }

    /**
     * Transferência de cartão para cartão (endpoint: /api/card/pay)
     * @param {Object} payload - Dados da transferência
     * @returns {Object} Resultado da API
     */
    async transferCardToCard(payload) {
        const response = await axios.post(
            `${CONFIG.API_URL}/api/card/pay`,
            {
                fromCard: payload.fromCard,
                toCard: payload.toCard,
                amount: this.formatCoinAmount(payload.amount)
            },
            { timeout: CONFIG.API_TIMEOUT }
        );
        
        if (!response.data || !response.data.success) {
            throw new Error(response.data?.error || 'Falha na transferência');
        }
        
        return {
            success: true,
            txId: response.data.txId,
            date: response.data.date
        };
    }

    /**
     * Formata a quantia para 8 casas decimais sem notação científica
     * @param {number} amount - Quantia a ser formatada
     * @returns {string} Quantia formatada como string decimal
     */
    formatCoinAmount(amount) {
        // Garantir que é número e tem 8 casas decimais
        const num = Number(amount);
        if (isNaN(num)) return '0.00000000';
        
        // Usar toFixed para garantir 8 casas decimais e depois remover zeros à direita desnecessários
        // mas manter pelo menos 1 casa decimal se necessário
        let formatted = num.toFixed(8);
        
        // Remover zeros à direita, mas manter pelo menos uma casa decimal se o número não for inteiro
        if (formatted.includes('.')) {
            formatted = formatted.replace(/0+$/, '').replace(/\.$/, '');
        }
        
        return formatted;
    }
}

// Instância global da fila
const paymentQueue = new PaymentQueue();

// ===================== FUNÇÕES UTILITÁRIAS =====================

/**
 * Aplica máscara no cartão (mostra só 3 primeiros caracteres)
 * @param {string} cardId - ID do cartão
 * @returns {string} Cartão mascarado
 */
function maskCardId(cardId) {
    if (!cardId || cardId.length < 3) return '###';
    const first3 = cardId.substring(0, 3);
    return first3 + '#'.repeat(Math.max(0, cardId.length - 3));
}

/**
 * Formata valor em coins (8 casas decimais) sem notação científica
 * @param {number} amount - Quantia em coins
 * @returns {string} Valor formatado como string decimal
 */
function formatCoin(amount) {
    const num = Number(amount);
    if (isNaN(num)) return '0';
    
    // Usar toFixed para garantir representação decimal sem notação científica
    let formatted = num.toFixed(8);
    
    // Remover zeros à direita, mas manter pelo menos uma casa decimal se necessário
    if (formatted.includes('.')) {
        formatted = formatted.replace(/0+$/, '').replace(/\.$/, '');
    }
    
    return formatted;
}

/**
 * Formata valor em reais (2 casas decimais)
 * @param {number} amount - Quantia em reais
 * @returns {string} Valor formatado
 */
function formatDollar(amount) {
    const num = Number(amount);
    if (isNaN(num)) return '0.00';
    return num.toFixed(2);
}

/**
 * Trunca valor para 8 casas decimais sem notação científica
 * @param {number} amount - Quantia a ser truncada
 * @returns {string} Valor truncado como string
 */
function truncateCoin(amount) {
    const num = Number(amount);
    if (isNaN(num)) return '0.00000000';
    
    // Truncar para 8 casas decimais sem arredondamento
    const truncated = Math.floor(num * 1e8) / 1e8;
    
    // Garantir formato sem notação científica
    return truncated.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/**
 * Trunca valor para 2 casas decimais (formato real)
 * @param {number} amount - Quantia a ser truncada
 * @returns {number} Valor truncado
 */
function truncateDollar(amount) {
    const num = Number(amount);
    if (isNaN(num)) return 0;
    return Math.floor(num * 100) / 100;
}

/**
 * Converte valor para formato aceito pela API (string sem notação científica)
 * @param {number} amount - Valor a ser convertido
 * @returns {string} Valor formatado para API
 */
function toApiFormat(amount) {
    const num = Number(amount);
    if (isNaN(num)) return '0.00000000';
    
    // Garantir que tem pelo menos 8 casas decimais quando necessário
    // Mas remover zeros à direita para valores inteiros
    let formatted = num.toFixed(8);
    
    // Se for um número inteiro (ex: 1.00000000), mostrar como "1"
    if (formatted.endsWith('.00000000')) {
        return formatted.substring(0, formatted.length - 9);
    }
    
    // Remover zeros à direita, mas manter o ponto decimal se necessário
    formatted = formatted.replace(/0+$/, '');
    if (formatted.endsWith('.')) {
        formatted = formatted.slice(0, -1);
    }
    
    return formatted;
}

/**
 * Cria embed base com thumbnail
 * @param {string} title - Título do embed
 * @param {string} color - Cor do embed (hex)
 * @returns {EmbedBuilder} Embed configurado
 */
function createBaseEmbed(title, color = '#0099ff') {
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setTimestamp();
    
    // Adiciona thumbnail se o arquivo existir
    if (fs.existsSync(CONFIG.ICON_PATH)) {
        embed.setThumbnail('attachment://icon.png');
    }
    
    return embed;
}

/**
 * Cria embed de log (sem thumbnail)
 * @param {string} title - Título do embed
 * @param {string} color - Cor do embed (hex)
 * @returns {EmbedBuilder} Embed configurado
 */
function createLogEmbed(title, color = '#808080') {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setTimestamp();
}

/**
 * Envia log para o canal configurado
 * @param {string} guildId - ID do servidor
 * @param {EmbedBuilder} embed - Embed a ser enviado
 */
async function sendLog(guildId, embed) {
    try {
        const config = await db.get('SELECT log_channel_id FROM guild_config WHERE guild_id = ?', guildId);
        if (!config?.log_channel_id) return;
        
        const channel = await client.channels.fetch(config.log_channel_id);
        if (channel) {
            await channel.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error('Erro ao enviar log:', error);
    }
}

/**
 * Verifica se o membro tem permissão de staff
 * @param {string} guildId - ID do servidor
 * @param {GuildMember} member - Membro a ser verificado
 * @returns {boolean} True se for staff
 */
async function isStaff(guildId, member) {
    const config = await db.get('SELECT staff_role_id FROM guild_config WHERE guild_id = ?', guildId);
    if (!config?.staff_role_id) return false;
    
    return member.roles.cache.has(config.staff_role_id);
}

/**
 * Verifica status do cartão na API (endpoint: /api/card/info)
 * @param {string} cardId - ID do cartão
 * @returns {Object} Status do cartão
 */
async function checkCardStatus(cardId) {
    try {
        const response = await axios.post(
            `${CONFIG.API_URL}/api/card/info`,
            { cardCode: cardId },
            { timeout: CONFIG.API_TIMEOUT }
        );
        
        return response.data;
    } catch (error) {
        if (error.response?.status === 404) {
            return { success: false, found: false, error: 'CARD_NOT_FOUND' };
        }
        throw error;
    }
}

// ===================== REGISTRO DE COMANDOS SLASH =====================
/**
 * Registra todos os comandos slash globalmente (substitui os existentes)
 */
async function registerSlashCommands() {
    const commands = [
        // ===== COMANDOS /MONEY (para usuários) =====
        {
            name: 'money',
            description: 'Comandos de dinheiro e carteira',
            options: [
                {
                    name: 'balance',
                    description: 'Mostra seu saldo em reais e coins',
                    type: 1 // SUB_COMMAND
                },
                {
                    name: 'pay',
                    description: 'Paga reais para outro usuário',
                    type: 1,
                    options: [
                        {
                            name: 'user',
                            description: 'Usuário que receberá o pagamento',
                            type: 6, // USER
                            required: true
                        },
                        {
                            name: 'amount',
                            description: 'Quantia em reais (ex: 10.50)',
                            type: 3, // STRING
                            required: true
                        }
                    ]
                },
                {
                    name: 'withdraw',
                    description: 'Saca reais convertendo para coins',
                    type: 1,
                    options: [
                        {
                            name: 'amount',
                            description: 'Quantia em reais (ex: 10.00)',
                            type: 3,
                            required: true
                        }
                    ]
                },
                {
                    name: 'deposit',
                    description: 'Deposita coins convertendo para reais',
                    type: 1,
                    options: [
                        {
                            name: 'amount',
                            description: 'Quantia em reais (ex: 10.00)',
                            type: 3,
                            required: true
                        }
                    ]
                }
            ]
        },
        
        // ===== COMANDOS /SERVER (configuração do servidor) =====
        {
            name: 'server',
            description: 'Comandos de configuração do servidor (Admin)',
            options: [
                {
                    name: 'card',
                    description: 'Configura o cartão do servidor',
                    type: 1,
                    options: [
                        {
                            name: 'card_id',
                            description: 'ID do cartão do servidor',
                            type: 3,
                            required: true
                        }
                    ]
                },
                {
                    name: 'log',
                    description: 'Configura o canal de logs',
                    type: 1,
                    options: [
                        {
                            name: 'channel',
                            description: 'Canal para receber os logs',
                            type: 7, // CHANNEL
                            required: true
                        }
                    ]
                },
                {
                    name: 'balance',
                    description: 'Mostra o saldo do servidor em coins',
                    type: 1
                },
                {
                    name: 'pay',
                    description: 'Servidor paga coins para um usuário',
                    type: 1,
                    options: [
                        {
                            name: 'user',
                            description: 'Usuário que receberá o pagamento',
                            type: 6,
                            required: true
                        },
                        {
                            name: 'amount',
                            description: 'Quantia em coins (ex: 0.00000001)',
                            type: 3,
                            required: true
                        }
                    ]
                },
                {
                    name: 'fine',
                    description: 'Aplica multa em coins a um usuário',
                    type: 1,
                    options: [
                        {
                            name: 'user',
                            description: 'Usuário que será multado',
                            type: 6,
                            required: true
                        },
                        {
                            name: 'amount',
                            description: 'Quantia em coins (ex: 0.00000001)',
                            type: 3,
                            required: true
                        }
                    ]
                }
            ]
        },
        
        // ===== COMANDOS /ADM (administração de economia) =====
        {
            name: 'adm',
            description: 'Comandos administrativos para economia (Staff)',
            options: [
                {
                    name: 'setstaff',
                    description: 'Configura o cargo de staff',
                    type: 1,
                    options: [
                        {
                            name: 'role',
                            description: 'Cargo que terá permissões de staff',
                            type: 8, // ROLE
                            required: true
                        }
                    ]
                },
                {
                    name: 'give',
                    description: 'Adiciona reais a um usuário',
                    type: 1,
                    options: [
                        {
                            name: 'user',
                            description: 'Usuário que receberá os reais',
                            type: 6,
                            required: true
                        },
                        {
                            name: 'amount',
                            description: 'Quantia em reais (ex: 100.00)',
                            type: 3,
                            required: true
                        }
                    ]
                },
                {
                    name: 'take',
                    description: 'Remove reais de um usuário',
                    type: 1,
                    options: [
                        {
                            name: 'user',
                            description: 'Usuário que terá reais removidos',
                            type: 6,
                            required: true
                        },
                        {
                            name: 'amount',
                            description: 'Quantia em reais (ex: 50.00)',
                            type: 3,
                            required: true
                        }
                    ]
                },
                {
                    name: 'set',
                    description: 'Define o saldo em reais de um usuário',
                    type: 1,
                    options: [
                        {
                            name: 'user',
                            description: 'Usuário que terá o saldo definido',
                            type: 6,
                            required: true
                        },
                        {
                            name: 'amount',
                            description: 'Quantia em reais (ex: 200.00)',
                            type: 3,
                            required: true
                        }
                    ]
                }
            ]
        },
        
        // ===== COMANDOS AVULSOS =====
        {
            name: 'setcard',
            description: 'Configura seu cartão Coin',
            options: [{
                name: 'card_id',
                description: 'Seu ID do cartão',
                type: 3,
                required: true
            }]
        },
        {
            name: 'coinbalance',
            description: 'Mostra seu saldo em coins'
        },
        {
            name: 'baltop',
            description: 'Mostra o ranking de riqueza',
            options: [{
                name: 'page',
                description: 'Número da página',
                type: 4, // INTEGER
                required: false
            }]
        },
        {
            name: 'payserver',
            description: 'Paga coins para o servidor',
            options: [{
                name: 'amount',
                description: 'Quantia em coins (ex: 0.00000001)',
                type: 3,
                required: true
            }]
        }
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(CONFIG.BOT_TOKEN);
        
        console.log('🔄 Deletando comandos antigos e registrando novos comandos slash globalmente...');
        
        // Registrar novos comandos
        await rest.put(
            Routes.applicationCommands(CONFIG.BOT_CLIENT_ID),
            { body: commands }
        );
        
        console.log('✅ Comandos slash registrados com sucesso!');
    } catch (error) {
        console.error('❌ Erro ao registrar comandos slash:', error);
    }
}

// ===================== HANDLER DE INTERAÇÕES =====================
/**
 * Processa todas as interações de comandos slash
 */
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    
    const { commandName, options, guild, member, user } = interaction;
    
    try {
        await interaction.deferReply();
        
        // ===== COMANDO /SETCARD =====
        if (commandName === 'setcard') {
            const cardId = options.getString('card_id');
            const guildId = guild.id;
            const userId = user.id;
            
            try {
                // Salva no banco de dados sem verificar na API
                await db.run(
                    `INSERT INTO users (user_id, guild_id, card_id, dollars) 
                     VALUES (?, ?, ?, 0) 
                     ON CONFLICT(user_id, guild_id) 
                     DO UPDATE SET card_id = ?, updated_at = CURRENT_TIMESTAMP`,
                    [userId, guildId, cardId, cardId]
                );
                
                const embed = createBaseEmbed('✅ Cartão Configurado', '#00ff00')
                    .setDescription(`Seu cartão foi configurado com sucesso!`)
                    .addFields(
                        { name: 'Cartão', value: maskCardId(cardId), inline: true }
                    );
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                
                // Log da operação
                const logEmbed = createLogEmbed('📝 Configuração de Cartão', '#00ff00')
                    .setDescription(`Usuário configurou cartão`)
                    .addFields(
                        { name: 'Usuário', value: user.tag },
                        { name: 'Cartão', value: maskCardId(cardId) }
                    );
                await sendLog(guildId, logEmbed);
                
            } catch (error) {
                console.error('Erro ao configurar cartão:', error);
                const embed = createBaseEmbed('❌ Erro', '#ff0000')
                    .setDescription('Ocorreu um erro ao configurar o cartão. Tente novamente.');
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
        }
        
        // ===== COMANDO /COINBALANCE =====
        else if (commandName === 'coinbalance') {
            const guildId = guild.id;
            const userId = user.id;
            
            // Busca o cartão do usuário
            const userData = await db.get('SELECT card_id FROM users WHERE user_id = ? AND guild_id = ?', userId, guildId);
            
            if (!userData?.card_id) {
                const embed = createBaseEmbed('❌ Cartão não configurado', '#ff0000')
                    .setDescription('Use `/setcard` para configurar seu cartão primeiro.');
                return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
            
            try {
                const status = await checkCardStatus(userData.card_id);
                
                const embed = createBaseEmbed('💰 Seu Saldo em Coins', '#0099ff')
                    .addFields(
                        { name: 'Saldo', value: `${formatCoin(status.coins || 0)} coins`, inline: true },
                        { name: 'Total de Transações', value: `${status.totalTransactions || 0}`, inline: true }
                    );
                
                if (status.cooldownRemainingMs > 0) {
                    embed.addFields({ name: 'Próximo Claim', value: `${Math.ceil(status.cooldownRemainingMs / 60000)} minutos`, inline: true });
                }
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                
            } catch (error) {
                console.error('Erro ao verificar saldo:', error);
                const embed = createBaseEmbed('❌ Erro', '#ff0000')
                    .setDescription('Ocorreu um erro ao verificar seu saldo.');
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
        }
        
        // ===== COMANDO /BALTOP =====
        else if (commandName === 'baltop') {
            const page = options.getInteger('page') || 1;
            
            const guildId = guild.id;
            const userId = user.id;
            const limit = 10;
            const offset = (page - 1) * limit;
            
            // Busca top usuários
            const topUsers = await db.all(`
                SELECT user_id, dollars, card_id 
                FROM users 
                WHERE guild_id = ? 
                ORDER BY dollars DESC 
                LIMIT ? OFFSET ?
            `, guildId, limit, offset);
            
            // Busca totais
            const totals = await db.get(`
                SELECT 
                    SUM(dollars) as total_dollars,
                    COUNT(*) as total_users
                FROM users 
                WHERE guild_id = ?
            `, guildId);
            
            // Busca saldo do usuário atual
            const userData = await db.get('SELECT dollars FROM users WHERE user_id = ? AND guild_id = ?', userId, guildId);
            const userDollars = userData?.dollars || 0;
            
            // Busca saldo total em coins
            let totalCoins = 0;
            for (const user of topUsers) {
                if (user.card_id) {
                    try {
                        const status = await checkCardStatus(user.card_id);
                        if (status.success) {
                            user.coins = status.coins || 0;
                            totalCoins += user.coins;
                        }
                    } catch (error) {
                        user.coins = 0;
                    }
                } else {
                    user.coins = 0;
                }
            }
            
            // Constrói a lista
            let description = '';
            for (let i = 0; i < topUsers.length; i++) {
                const user = topUsers[i];
                const discordUser = await client.users.fetch(user.user_id).catch(() => null);
                const username = discordUser ? discordUser.tag : `Usuário ${user.user_id}`;
                const position = offset + i + 1;
                
                description += `**${position}.** ${username}\n`;
                description += `└ 💵 ${CONFIG.CURRENCY_SYMBOL}${formatDollar(user.dollars)} | 🪙 ${formatCoin(user.coins || 0)} coins\n\n`;
            }
            
            const embed = createBaseEmbed('🏆 Ranking de Riqueza', '#FFD700')
                .setDescription(description || 'Nenhum usuário encontrado.')
                .addFields(
                    { name: 'Total na Economia', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(totals?.total_dollars || 0)}`, inline: true },
                    { name: 'Total em Coins', value: `${formatCoin(totalCoins)}`, inline: true },
                    { name: 'Total de Usuários', value: `${totals?.total_users || 0}`, inline: true },
                    { name: 'Seu Saldo', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(userDollars)}`, inline: true }
                )
                .setFooter({ text: `Página ${page}` });
            
            await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
        }
        
        // ===== COMANDO /MONEY (subcomandos) =====
        else if (commandName === 'money') {
            const subcommand = options.getSubcommand();
            
            // Subcomando: balance
            if (subcommand === 'balance') {
                const guildId = guild.id;
                const userId = user.id;
                
                const userData = await db.get('SELECT card_id, dollars FROM users WHERE user_id = ? AND guild_id = ?', userId, guildId);
                const dollars = userData?.dollars || 0;
                
                // Busca saldo em coins
                let coins = 0;
                if (userData?.card_id) {
                    try {
                        const status = await checkCardStatus(userData.card_id);
                        if (status.success) coins = status.coins || 0;
                    } catch (error) {
                        console.error('Erro ao buscar saldo em coins:', error);
                    }
                }
                
                const embed = createBaseEmbed('💰 Seu Saldo', '#0099ff')
                    .addFields(
                        { name: 'Saldo em Reais', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollars)}`, inline: true },
                        { name: 'Saldo em Coins', value: `${formatCoin(coins)} coins`, inline: true }
                    );
                
                if (!userData?.card_id) {
                    embed.setFooter({ text: 'Configure seu cartão com /setcard para ver saldo em coins' });
                }
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
            
            // Subcomando: pay
            else if (subcommand === 'pay') {
                const targetUser = options.getUser('user');
                const amountStr = options.getString('amount');
                const dollarAmount = parseFloat(amountStr);
                
                if (isNaN(dollarAmount) || dollarAmount <= 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const userId = user.id;
                const dollarAmountTruncated = truncateDollar(dollarAmount);
                
                // Busca dados do pagador
                const payerData = await db.get('SELECT card_id, dollars FROM users WHERE user_id = ? AND guild_id = ?', userId, guildId);
                
                // Verifica saldo em reais
                const currentDollars = payerData?.dollars || 0;
                if (currentDollars < dollarAmountTruncated) {
                    const embed = createBaseEmbed('❌ Saldo Insuficiente em Reais', '#ff0000')
                        .setDescription(`Você tem apenas ${CONFIG.CURRENCY_SYMBOL}${formatDollar(currentDollars)}`);
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Busca dados do recebedor
                const receiverData = await db.get('SELECT user_id FROM users WHERE user_id = ? AND guild_id = ?', targetUser.id, guildId);
                
                // Se o recebedor não existir no banco, cria um registro para ele com saldo 0
                if (!receiverData) {
                    await db.run(
                        `INSERT INTO users (user_id, guild_id, dollars) 
                         VALUES (?, ?, 0)`,
                        [targetUser.id, guildId]
                    );
                }
                
                try {
                    // Atualiza saldo do pagador (diminui)
                    const newPayerDollars = truncateDollar(currentDollars - dollarAmountTruncated);
                    await db.run(
                        'UPDATE users SET dollars = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND guild_id = ?',
                        [newPayerDollars, userId, guildId]
                    );
                    
                    // Atualiza saldo do recebedor (aumenta)
                    await db.run(
                        `INSERT INTO users (user_id, guild_id, dollars) 
                         VALUES (?, ?, ?) 
                         ON CONFLICT(user_id, guild_id) 
                         DO UPDATE SET dollars = dollars + ?, updated_at = CURRENT_TIMESTAMP`,
                        [targetUser.id, guildId, dollarAmountTruncated, dollarAmountTruncated]
                    );
                    
                    // Busca novo saldo do recebedor para mostrar
                    const receiverNewData = await db.get('SELECT dollars FROM users WHERE user_id = ? AND guild_id = ?', targetUser.id, guildId);
                    
                    const successEmbed = createBaseEmbed('✅ Pagamento em Reais Realizado', '#00ff00')
                        .setDescription(`Pagamento de **${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmountTruncated)}** enviado com sucesso!`)
                        .addFields(
                            { name: 'Para', value: targetUser.tag, inline: true },
                            { name: 'Seu novo saldo', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(newPayerDollars)}`, inline: true },
                            { name: 'Saldo do destinatário', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(receiverNewData?.dollars || 0)}`, inline: true }
                        );
                    
                    await interaction.editReply({ embeds: [successEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                    
                    // Log da operação
                    const logEmbed = createLogEmbed('💰 Pagamento em Reais', '#00ff00')
                        .addFields(
                            { name: 'De', value: user.tag },
                            { name: 'Para', value: targetUser.tag },
                            { name: 'Valor', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmountTruncated)}` }
                        );
                    await sendLog(guildId, logEmbed);
                    
                } catch (error) {
                    console.error('Erro no pagamento:', error);
                    const errorEmbed = createBaseEmbed('❌ Erro', '#ff0000')
                        .setDescription('Ocorreu um erro ao processar o pagamento.');
                    await interaction.editReply({ embeds: [errorEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
            }
            
            // Subcomando: deposit (converte reais para coins)
            else if (subcommand === 'deposit') {
                const amountStr = options.getString('amount');
                const dollarAmount = parseFloat(amountStr);
                
                if (isNaN(dollarAmount) || dollarAmount <= 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const userId = user.id;
                
                // Busca dados do usuário
                const userData = await db.get('SELECT card_id, dollars FROM users WHERE user_id = ? AND guild_id = ?', userId, guildId);
                
                if (!userData?.card_id) {
                    const embed = createBaseEmbed('❌ Cartão não configurado', '#ff0000')
                        .setDescription('Configure seu cartão primeiro com `/setcard`');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Verifica saldo em reais
                const currentDollars = userData.dollars || 0;
                if (currentDollars < dollarAmount) {
                    const embed = createBaseEmbed('❌ Saldo Insuficiente em Reais', '#ff0000')
                        .setDescription(`Você tem apenas ${CONFIG.CURRENCY_SYMBOL}${formatDollar(currentDollars)}`);
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Busca configurações do servidor
                const config = await db.get('SELECT server_card_id FROM guild_config WHERE guild_id = ?', guildId);
                if (!config?.server_card_id) {
                    const embed = createBaseEmbed('❌ Servidor não configurado', '#ff0000')
                        .setDescription('O servidor ainda não configurou um cartão. Um administrador precisa usar `/server card`.');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Verifica se o cartão do servidor existe na API
                const serverCardStatus = await checkCardStatus(config.server_card_id);
                
                // Calcula conversão: 1 real = 0.00000001 coins (1 satoshi)
                const coinAmount = dollarAmount * 0.00000001;
                const formattedCoinAmount = toApiFormat(coinAmount);
                
                // Verifica se o servidor tem saldo suficiente
                if (serverCardStatus.coins < coinAmount) {
                    const embed = createBaseEmbed('❌ Servidor sem Saldo', '#ff0000')
                        .setDescription('O servidor não tem saldo suficiente para processar este depósito. Contacte um administrador.');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                try {
                    // Processa o depósito (servidor paga para o usuário)
                    const result = await paymentQueue.add({
                        guildId,
                        userId,
                        type: 'card_to_id',
                        payload: {
                            fromCard: config.server_card_id,
                            toId: userId,
                            amount: coinAmount
                        },
                        onSuccess: async (result) => {
                            // Atualiza saldo em reais do usuário (diminui)
                            const newDollars = truncateDollar(currentDollars - dollarAmount);
                            await db.run(
                                'UPDATE users SET dollars = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND guild_id = ?',
                                [newDollars, userId, guildId]
                            );
                            
                            const successEmbed = createBaseEmbed('✅ Depósito Realizado', '#00ff00')
                                .setDescription(`Depósito de **${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}** convertido com sucesso!`)
                                .addFields(
                                    { name: 'Você recebeu', value: `${formatCoin(coinAmount)} coins`, inline: true },
                                    { name: 'Saldo atual em reais', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(newDollars)}`, inline: true },
                                    { name: 'ID da Transação', value: `\`${result.txId}\``, inline: false }
                                );
                            
                            await interaction.editReply({ embeds: [successEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                            
                            const logEmbed = createLogEmbed('💰 Depósito Realizado', '#00ff00')
                                .addFields(
                                    { name: 'Usuário', value: user.tag },
                                    { name: 'Valor depositado', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}` },
                                    { name: 'Coins recebidos', value: `${formatCoin(coinAmount)}` },
                                    { name: 'ID da Transação', value: `\`${result.txId}\`` }
                                );
                            await sendLog(guildId, logEmbed);
                        }
                    });
                    
                } catch (error) {
                    console.error('Erro no depósito:', error);
                    const errorEmbed = createBaseEmbed('❌ Erro', '#ff0000')
                        .setDescription('Ocorreu um erro ao processar o depósito.');
                    await interaction.editReply({ embeds: [errorEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
            }
            
            // Subcomando: withdraw (converte coins para reais)
            else if (subcommand === 'withdraw') {
                const amountStr = options.getString('amount');
                const dollarAmount = parseFloat(amountStr);
                
                if (isNaN(dollarAmount) || dollarAmount <= 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const userId = user.id;
                
                // Busca dados do usuário
                const userData = await db.get('SELECT card_id, dollars FROM users WHERE user_id = ? AND guild_id = ?', userId, guildId);
                
                if (!userData?.card_id) {
                    const embed = createBaseEmbed('❌ Cartão não configurado', '#ff0000')
                        .setDescription('Configure seu cartão primeiro com `/setcard`');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Busca configurações do servidor
                const config = await db.get('SELECT server_card_id FROM guild_config WHERE guild_id = ?', guildId);
                if (!config?.server_card_id) {
                    const embed = createBaseEmbed('❌ Servidor não configurado', '#ff0000')
                        .setDescription('O servidor ainda não configurou um cartão. Um administrador precisa usar `/server card`.');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Verifica se o cartão do servidor existe na API
                const serverCardStatus = await checkCardStatus(config.server_card_id);
                
                // Calcula conversão: reais -> coins
                const coinAmount = dollarAmount * 0.00000001;
                const formattedCoinAmount = toApiFormat(coinAmount);
                
                // Verifica saldo em coins do usuário
                const userCardStatus = await checkCardStatus(userData.card_id);
                if (!userCardStatus.success || userCardStatus.coins < coinAmount) {
                    const embed = createBaseEmbed('❌ Saldo Insuficiente em Coins', '#ff0000')
                        .setDescription(`Você precisa de ${formatCoin(coinAmount)} coins, mas tem apenas ${formatCoin(userCardStatus.coins || 0)}`);
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                try {
                    // Processa o saque (usuário paga para o servidor)
                    const result = await paymentQueue.add({
                        guildId,
                        userId,
                        type: 'card_to_card',
                        payload: {
                            fromCard: userData.card_id,
                            toCard: config.server_card_id,
                            amount: coinAmount
                        },
                        onSuccess: async (result) => {
                            // Atualiza saldo em reais do usuário (aumenta)
                            const newDollars = truncateDollar((userData.dollars || 0) + dollarAmount);
                            await db.run(
                                'UPDATE users SET dollars = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND guild_id = ?',
                                [newDollars, userId, guildId]
                            );
                            
                            const successEmbed = createBaseEmbed('✅ Saque Realizado', '#00ff00')
                                .setDescription(`Saque de **${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}** convertido com sucesso!`)
                                .addFields(
                                    { name: 'Você pagou', value: `${formatCoin(coinAmount)} coins`, inline: true },
                                    { name: 'Saldo atual em reais', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(newDollars)}`, inline: true },
                                    { name: 'ID da Transação', value: `\`${result.txId}\``, inline: false }
                                );
                            
                            await interaction.editReply({ embeds: [successEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                            
                            const logEmbed = createLogEmbed('💰 Saque Realizado', '#00ff00')
                                .addFields(
                                    { name: 'Usuário', value: user.tag },
                                    { name: 'Valor sacado', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}` },
                                    { name: 'Coins pagos', value: `${formatCoin(coinAmount)}` },
                                    { name: 'ID da Transação', value: `\`${result.txId}\`` }
                                );
                            await sendLog(guildId, logEmbed);
                        }
                    });
                    
                } catch (error) {
                    console.error('Erro no saque:', error);
                    const errorEmbed = createBaseEmbed('❌ Erro', '#ff0000')
                        .setDescription('Ocorreu um erro ao processar o saque.');
                    await interaction.editReply({ embeds: [errorEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
            }
        }
        
        // ===== COMANDO /PAYSERVER =====
        else if (commandName === 'payserver') {
            const amountStr = options.getString('amount');
            const amount = parseFloat(amountStr);
            
            if (isNaN(amount) || amount <= 0) {
                return interaction.editReply('❌ Valor inválido.');
            }
            
            const guildId = guild.id;
            const userId = user.id;
            const coinAmount = amount;
            const formattedCoinAmount = toApiFormat(coinAmount);
            
            // Busca configurações do servidor
            const config = await db.get('SELECT server_card_id FROM guild_config WHERE guild_id = ?', guildId);
            if (!config?.server_card_id) {
                const embed = createBaseEmbed('❌ Servidor não configurado', '#ff0000')
                    .setDescription('O servidor ainda não configurou um cartão.');
                return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
            
            // Busca cartão do usuário
            const userData = await db.get('SELECT card_id FROM users WHERE user_id = ? AND guild_id = ?', userId, guildId);
            if (!userData?.card_id) {
                const embed = createBaseEmbed('❌ Cartão não configurado', '#ff0000')
                    .setDescription('Use `/setcard` para configurar seu cartão primeiro.');
                return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
            
            // Verifica saldo do usuário
            const userCardStatus = await checkCardStatus(userData.card_id);
            if (!userCardStatus.success || userCardStatus.coins < coinAmount) {
                const embed = createBaseEmbed('❌ Saldo Insuficiente', '#ff0000')
                    .setDescription(`Você não tem saldo suficiente.`)
                    .addFields(
                        { name: 'Seu saldo', value: `${formatCoin(userCardStatus.coins || 0)} coins` },
                        { name: 'Valor', value: `${formatCoin(coinAmount)} coins` }
                    );
                return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
            
            try {
                // Processa o pagamento para o servidor
                const result = await paymentQueue.add({
                    guildId,
                    userId,
                    type: 'card_to_id',
                    payload: {
                        fromCard: userData.card_id,
                        toId: userId,
                        amount: coinAmount
                    },
                    onSuccess: async (result) => {
                        const successEmbed = createBaseEmbed('✅ Pagamento ao Servidor Realizado', '#00ff00')
                            .setDescription(`Pagamento de **${formatCoin(coinAmount)} coins** enviado com sucesso!`)
                            .addFields(
                                { name: 'ID da Transação', value: `\`${result.txId}\`` }
                            );
                        
                        await interaction.editReply({ embeds: [successEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                        
                        const logEmbed = createLogEmbed('🏦 Pagamento ao Servidor', '#00ff00')
                            .addFields(
                                { name: 'Usuário', value: user.tag },
                                { name: 'Valor', value: `${formatCoin(coinAmount)} coins` },
                                { name: 'ID da Transação', value: `\`${result.txId}\`` }
                            );
                        await sendLog(guildId, logEmbed);
                    }
                });
                
            } catch (error) {
                console.error('Erro no pagamento:', error);
                const errorEmbed = createBaseEmbed('❌ Erro', '#ff0000')
                    .setDescription('Ocorreu um erro ao processar o pagamento.');
                await interaction.editReply({ embeds: [errorEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
            }
        }
        
        // ===== COMANDO /SERVER (subcomandos) =====
        else if (commandName === 'server') {
            const subcommand = options.getSubcommand();
            
            // Subcomando: card - apenas registra o card sem verificar na API
            if (subcommand === 'card') {
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.editReply('❌ Apenas administradores podem usar este comando.');
                }
                
                const cardId = options.getString('card_id');
                const guildId = guild.id;
                
                try {
                    // Salva no banco de dados sem verificar na API
                    await db.run(
                        `INSERT INTO guild_config (guild_id, server_card_id) 
                         VALUES (?, ?) 
                         ON CONFLICT(guild_id) 
                         DO UPDATE SET server_card_id = ?, updated_at = CURRENT_TIMESTAMP`,
                        [guildId, cardId, cardId]
                    );
                    
                    const embed = createBaseEmbed('✅ Cartão do Servidor Configurado', '#00ff00')
                        .setDescription(`Cartão do servidor configurado com sucesso!`)
                        .addFields(
                            { name: 'Cartão', value: maskCardId(cardId), inline: true }
                        );
                    
                    await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                    
                    // Log da operação
                    const logEmbed = createLogEmbed('⚙️ Configuração do Servidor', '#00ff00')
                        .setDescription(`Cartão do servidor configurado`)
                        .addFields(
                            { name: 'Admin', value: user.tag },
                            { name: 'Cartão', value: maskCardId(cardId) }
                        );
                    await sendLog(guildId, logEmbed);
                    
                } catch (error) {
                    console.error('Erro ao configurar cartão do servidor:', error);
                    const embed = createBaseEmbed('❌ Erro', '#ff0000')
                        .setDescription('Ocorreu um erro ao configurar o cartão.');
                    await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
            }
            
            // Subcomando: log
            else if (subcommand === 'log') {
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.editReply('❌ Apenas administradores podem usar este comando.');
                }
                
                const channel = options.getChannel('channel');
                const guildId = guild.id;
                
                await db.run(
                    `INSERT INTO guild_config (guild_id, log_channel_id) 
                     VALUES (?, ?) 
                     ON CONFLICT(guild_id) 
                     DO UPDATE SET log_channel_id = ?, updated_at = CURRENT_TIMESTAMP`,
                    [guildId, channel.id, channel.id]
                );
                
                const embed = createBaseEmbed('✅ Canal de Log Configurado', '#00ff00')
                    .setDescription(`Logs serão enviados para ${channel}`);
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                
                // Teste do canal de log
                const testEmbed = createLogEmbed('📝 Canal de Log Configurado', '#00ff00')
                    .setDescription('Este canal agora receberá todos os logs do sistema.')
                    .addFields({ name: 'Configurado por', value: user.tag });
                
                await sendLog(guildId, testEmbed);
            }
            
            // Subcomando: balance
            else if (subcommand === 'balance') {
                const guildId = guild.id;
                
                const config = await db.get('SELECT server_card_id FROM guild_config WHERE guild_id = ?', guildId);
                
                if (!config?.server_card_id) {
                    const embed = createBaseEmbed('❌ Servidor não configurado', '#ff0000')
                        .setDescription('O servidor ainda não configurou um cartão.');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                try {
                    const status = await checkCardStatus(config.server_card_id);
                    
                    const embed = createBaseEmbed('🏦 Saldo do Servidor', '#0099ff')
                        .addFields(
                            { name: 'Saldo', value: `${formatCoin(status.coins || 0)} coins`, inline: true },
                            { name: 'Total de Transações', value: `${status.totalTransactions || 0}`, inline: true }
                        );
                    
                    await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                    
                } catch (error) {
                    console.error('Erro ao verificar saldo do servidor:', error);
                    const embed = createBaseEmbed('❌ Erro', '#ff0000')
                        .setDescription('Ocorreu um erro ao verificar o saldo do servidor.');
                    await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
            }
            
            // Subcomando: pay
            else if (subcommand === 'pay') {
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.editReply('❌ Apenas administradores podem usar este comando.');
                }
                
                const targetUser = options.getUser('user');
                const amountStr = options.getString('amount');
                const amount = parseFloat(amountStr);
                
                if (isNaN(amount) || amount <= 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const coinAmount = amount;
                const formattedCoinAmount = toApiFormat(coinAmount);
                
                // Busca configurações do servidor
                const config = await db.get('SELECT server_card_id FROM guild_config WHERE guild_id = ?', guildId);
                if (!config?.server_card_id) {
                    const embed = createBaseEmbed('❌ Servidor não configurado', '#ff0000')
                        .setDescription('O servidor ainda não configurou um cartão. Use `/server card` primeiro.');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Verifica se o cartão do servidor existe na API
                const serverCardStatus = await checkCardStatus(config.server_card_id);
                
                // Verifica saldo do servidor
                if (serverCardStatus.coins < coinAmount) {
                    const embed = createBaseEmbed('❌ Saldo Insuficiente no Servidor', '#ff0000')
                        .setDescription(`O servidor não tem saldo suficiente.`)
                        .addFields(
                            { name: 'Saldo do servidor', value: `${formatCoin(serverCardStatus.coins || 0)} coins` },
                            { name: 'Valor do pagamento', value: `${formatCoin(coinAmount)} coins` }
                        );
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Busca cartão do usuário
                const userData = await db.get('SELECT card_id FROM users WHERE user_id = ? AND guild_id = ?', targetUser.id, guildId);
                if (!userData?.card_id) {
                    const embed = createBaseEmbed('❌ Usuário não configurado', '#ff0000')
                        .setDescription(`${targetUser.tag} ainda não configurou um cartão.`);
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                try {
                    // Processa o pagamento
                    const result = await paymentQueue.add({
                        guildId,
                        userId: user.id,
                        type: 'card_to_id',
                        payload: {
                            fromCard: config.server_card_id,
                            toId: targetUser.id,
                            amount: coinAmount
                        },
                        onSuccess: async (result) => {
                            const successEmbed = createBaseEmbed('✅ Pagamento do Servidor Realizado', '#00ff00')
                                .setDescription(`Pagamento de **${formatCoin(coinAmount)} coins** enviado com sucesso!`)
                                .addFields(
                                    { name: 'Para', value: targetUser.tag },
                                    { name: 'ID da Transação', value: `\`${result.txId}\`` }
                                );
                            
                            await interaction.editReply({ embeds: [successEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                            
                            const logEmbed = createLogEmbed('💰 Pagamento do Servidor', '#00ff00')
                                .addFields(
                                    { name: 'Admin', value: user.tag },
                                    { name: 'Usuário', value: targetUser.tag },
                                    { name: 'Valor', value: `${formatCoin(coinAmount)} coins` },
                                    { name: 'ID da Transação', value: `\`${result.txId}\`` }
                                );
                            await sendLog(guildId, logEmbed);
                        }
                    });
                    
                } catch (error) {
                    console.error('Erro no pagamento:', error);
                    const errorEmbed = createBaseEmbed('❌ Erro', '#ff0000')
                        .setDescription('Ocorreu um erro ao processar o pagamento.');
                    await interaction.editReply({ embeds: [errorEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
            }
            
            // Subcomando: fine
            else if (subcommand === 'fine') {
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.editReply('❌ Apenas administradores podem usar este comando.');
                }
                
                const targetUser = options.getUser('user');
                const amountStr = options.getString('amount');
                const amount = parseFloat(amountStr);
                
                if (isNaN(amount) || amount <= 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const coinAmount = amount;
                const formattedCoinAmount = toApiFormat(coinAmount);
                
                // Busca configurações do servidor
                const config = await db.get('SELECT server_card_id FROM guild_config WHERE guild_id = ?', guildId);
                if (!config?.server_card_id) {
                    const embed = createBaseEmbed('❌ Servidor não configurado', '#ff0000')
                        .setDescription('O servidor ainda não configurou um cartão.');
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Busca cartão do usuário
                const userData = await db.get('SELECT card_id FROM users WHERE user_id = ? AND guild_id = ?', targetUser.id, guildId);
                if (!userData?.card_id) {
                    const embed = createBaseEmbed('❌ Usuário não configurado', '#ff0000')
                        .setDescription(`${targetUser.tag} ainda não configurou um cartão.`);
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Verifica saldo do usuário
                const userCardStatus = await checkCardStatus(userData.card_id);
                if (!userCardStatus.success || userCardStatus.coins < coinAmount) {
                    const embed = createBaseEmbed('❌ Saldo Insuficiente', '#ff0000')
                        .setDescription(`${targetUser.tag} não tem saldo suficiente.`)
                        .addFields(
                            { name: 'Saldo atual', value: `${formatCoin(userCardStatus.coins || 0)} coins` },
                            { name: 'Valor da multa', value: `${formatCoin(coinAmount)} coins` }
                        );
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                try {
                    // Processa a multa
                    const result = await paymentQueue.add({
                        guildId,
                        userId: user.id,
                        type: 'card_to_id',
                        payload: {
                            fromCard: userData.card_id,
                            toId: user.id,
                            amount: coinAmount
                        },
                        onSuccess: async (result) => {
                            const successEmbed = createBaseEmbed('✅ Multa Aplicada', '#00ff00')
                                .setDescription(`Multa de **${formatCoin(coinAmount)} coins** aplicada com sucesso!`)
                                .addFields(
                                    { name: 'Usuário', value: targetUser.tag },
                                    { name: 'Valor', value: `${formatCoin(coinAmount)} coins` },
                                    { name: 'ID da Transação', value: `\`${result.txId}\`` }
                                );
                            
                            await interaction.editReply({ embeds: [successEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                            
                            const logEmbed = createLogEmbed('⚠️ Multa Aplicada', '#ff0000')
                                .addFields(
                                    { name: 'Admin', value: user.tag },
                                    { name: 'Usuário multado', value: targetUser.tag },
                                    { name: 'Valor', value: `${formatCoin(coinAmount)} coins` },
                                    { name: 'ID da Transação', value: `\`${result.txId}\`` }
                                );
                            await sendLog(guildId, logEmbed);
                        }
                    });
                    
                } catch (error) {
                    console.error('Erro na multa:', error);
                    const errorEmbed = createBaseEmbed('❌ Erro', '#ff0000')
                        .setDescription('Ocorreu um erro ao aplicar a multa.');
                    await interaction.editReply({ embeds: [errorEmbed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
            }
        }
        
        // ===== COMANDO /ADM (subcomandos) =====
        else if (commandName === 'adm') {
            const subcommand = options.getSubcommand();
            
            // Subcomando: setstaff
            if (subcommand === 'setstaff') {
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.editReply('❌ Apenas administradores podem usar este comando.');
                }
                
                const role = options.getRole('role');
                const guildId = guild.id;
                
                await db.run(
                    `INSERT INTO guild_config (guild_id, staff_role_id) 
                     VALUES (?, ?) 
                     ON CONFLICT(guild_id) 
                     DO UPDATE SET staff_role_id = ?, updated_at = CURRENT_TIMESTAMP`,
                    [guildId, role.id, role.id]
                );
                
                const embed = createBaseEmbed('✅ Cargo Staff Configurado', '#00ff00')
                    .setDescription(`Cargo ${role.name} agora tem permissões de staff.`);
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                
                const logEmbed = createLogEmbed('⚙️ Configuração de Staff', '#00ff00')
                    .addFields(
                        { name: 'Admin', value: user.tag },
                        { name: 'Cargo', value: role.name }
                    );
                await sendLog(guildId, logEmbed);
            }
            
            // Subcomando: give
            else if (subcommand === 'give') {
                if (!await isStaff(guild.id, member)) {
                    return interaction.editReply('❌ Você não tem permissão de staff.');
                }
                
                const targetUser = options.getUser('user');
                const amountStr = options.getString('amount');
                const amount = parseFloat(amountStr);
                
                if (isNaN(amount) || amount <= 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const dollarAmount = truncateDollar(amount);
                
                // Atualiza saldo
                await db.run(
                    `INSERT INTO users (user_id, guild_id, dollars) 
                     VALUES (?, ?, ?) 
                     ON CONFLICT(user_id, guild_id) 
                     DO UPDATE SET dollars = dollars + ?, updated_at = CURRENT_TIMESTAMP`,
                    [targetUser.id, guildId, dollarAmount, dollarAmount]
                );
                
                // Busca novo saldo
                const userData = await db.get('SELECT dollars FROM users WHERE user_id = ? AND guild_id = ?', targetUser.id, guildId);
                
                const embed = createBaseEmbed('✅ Reais Adicionados', '#00ff00')
                    .setDescription(`${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)} adicionados para ${targetUser.tag}`)
                    .addFields(
                        { name: 'Novo saldo', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(userData?.dollars || 0)}` }
                    );
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                
                const logEmbed = createLogEmbed('💰 Adição de Reais', '#00ff00')
                    .addFields(
                        { name: 'Staff', value: user.tag },
                        { name: 'Usuário', value: targetUser.tag },
                        { name: 'Valor adicionado', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}` }
                    );
                await sendLog(guildId, logEmbed);
            }
            
            // Subcomando: take
            else if (subcommand === 'take') {
                if (!await isStaff(guild.id, member)) {
                    return interaction.editReply('❌ Você não tem permissão de staff.');
                }
                
                const targetUser = options.getUser('user');
                const amountStr = options.getString('amount');
                const amount = parseFloat(amountStr);
                
                if (isNaN(amount) || amount <= 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const dollarAmount = truncateDollar(amount);
                
                // Verifica saldo atual
                const userData = await db.get('SELECT dollars FROM users WHERE user_id = ? AND guild_id = ?', targetUser.id, guildId);
                const currentDollars = userData?.dollars || 0;
                
                if (currentDollars < dollarAmount) {
                    const embed = createBaseEmbed('❌ Saldo Insuficiente', '#ff0000')
                        .setDescription(`${targetUser.tag} tem apenas ${CONFIG.CURRENCY_SYMBOL}${formatDollar(currentDollars)}`);
                    return interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                }
                
                // Atualiza saldo
                const newDollars = truncateDollar(currentDollars - dollarAmount);
                await db.run(
                    'UPDATE users SET dollars = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND guild_id = ?',
                    [newDollars, targetUser.id, guildId]
                );
                
                const embed = createBaseEmbed('✅ Reais Removidos', '#00ff00')
                    .setDescription(`${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)} removidos de ${targetUser.tag}`)
                    .addFields(
                        { name: 'Novo saldo', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(newDollars)}` }
                    );
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                
                const logEmbed = createLogEmbed('💰 Remoção de Reais', '#ff0000')
                    .addFields(
                        { name: 'Staff', value: user.tag },
                        { name: 'Usuário', value: targetUser.tag },
                        { name: 'Valor removido', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}` }
                    );
                await sendLog(guildId, logEmbed);
            }
            
            // Subcomando: set
            else if (subcommand === 'set') {
                if (!await isStaff(guild.id, member)) {
                    return interaction.editReply('❌ Você não tem permissão de staff.');
                }
                
                const targetUser = options.getUser('user');
                const amountStr = options.getString('amount');
                const amount = parseFloat(amountStr);
                
                if (isNaN(amount) || amount < 0) {
                    return interaction.editReply('❌ Valor inválido.');
                }
                
                const guildId = guild.id;
                const dollarAmount = truncateDollar(amount);
                
                // Define saldo
                await db.run(
                    `INSERT INTO users (user_id, guild_id, dollars) 
                     VALUES (?, ?, ?) 
                     ON CONFLICT(user_id, guild_id) 
                     DO UPDATE SET dollars = ?, updated_at = CURRENT_TIMESTAMP`,
                    [targetUser.id, guildId, dollarAmount, dollarAmount]
                );
                
                const embed = createBaseEmbed('✅ Saldo Definido', '#00ff00')
                    .setDescription(`Saldo de ${targetUser.tag} definido para ${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}`);
                
                await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
                
                const logEmbed = createLogEmbed('💰 Definição de Saldo', '#00ff00')
                    .addFields(
                        { name: 'Staff', value: user.tag },
                        { name: 'Usuário', value: targetUser.tag },
                        { name: 'Novo saldo', value: `${CONFIG.CURRENCY_SYMBOL}${formatDollar(dollarAmount)}` }
                    );
                await sendLog(guildId, logEmbed);
            }
        }
        
    } catch (error) {
        console.error(`❌ Erro no comando ${commandName}:`, error);
        const embed = createBaseEmbed('❌ Erro', '#ff0000')
            .setDescription('Ocorreu um erro ao executar este comando.');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
        } else {
            await interaction.reply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [], ephemeral: true });
        }
    }
});

// ===================== HANDLER DE MENSAGENS (comandos com prefixo) =====================
/**
 * Processa mensagens com prefixo para comando de ajuda
 */
client.on('messageCreate', async (message) => {
    // Ignora mensagens de bots
    if (message.author.bot) return;
    
    // Ignora mensagens sem prefixo
    if (!message.content.startsWith(CONFIG.BOT_PREFIX)) return;
    
    // Remove o prefixo e separa comando e argumentos
    const args = message.content.slice(CONFIG.BOT_PREFIX.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    
    // Comando de ajuda
    if (commandName === 'ajuda') {
        const embed = createBaseEmbed('📋 Comandos Disponíveis', '#0099ff')
            .setDescription('Use `/` para ver todos os comandos slash disponíveis!')
            .addFields(
                { name: '💰 /money', value: 
                    '`balance` - Ver saldo\n' +
                    '`pay` - Pagar outro usuário\n' +
                    '`withdraw` - Sacar reais para coins\n' +
                    '`deposit` - Depositar coins para reais'
                },
                { name: '🖥️ /server', value: 
                    '`card` - Configurar cartão do servidor (Admin)\n' +
                    '`log` - Configurar canal de logs (Admin)\n' +
                    '`balance` - Ver saldo do servidor\n' +
                    '`pay` - Servidor pagar usuário (Admin)\n' +
                    '`fine` - Aplicar multa (Admin)'
                },
                { name: '⚙️ /adm', value: 
                    '`setstaff` - Configurar cargo staff (Admin)\n' +
                    '`give` - Adicionar reais (Staff)\n' +
                    '`take` - Remover reais (Staff)\n' +
                    '`set` - Definir saldo (Staff)'
                },
                { name: '🔧 Outros', value: 
                    '`/setcard` - Configurar seu cartão\n' +
                    '`/coinbalance` - Ver saldo em coins\n' +
                    '`/baltop` - Ver ranking\n' +
                    '`/payserver` - Pagar ao servidor'
                }
            );
        
        await message.reply({ embeds: [embed], files: fs.existsSync(CONFIG.ICON_PATH) ? ['icon.png'] : [] });
    }
});

// ===================== INICIALIZAÇÃO =====================
/**
 * Inicia o bot e todas as suas dependências
 */
async function start() {
    try {
        // Inicializa banco de dados
        await initDatabase();
        
        // Registra comandos slash (substitui os existentes)
        await registerSlashCommands();
        
        // Loga no Discord
        await client.login(CONFIG.BOT_TOKEN);
        console.log('✅ Bot conectado ao Discord com sucesso');
        
        // Define status do bot
        client.user.setActivity('/ajuda', { type: 'WATCHING' });
        
    } catch (error) {
        console.error('❌ Erro ao iniciar bot:', error);
        process.exit(1);
    }
}

// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Exceção não capturada:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Promise rejeitada não tratada:', error);
});

// Inicia o bot
start();
