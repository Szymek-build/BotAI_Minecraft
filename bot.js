const mineflayer = require('mineflayer');
const axios = require('axios');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;

const COHERE_API_KEY = 'Klucz_api';
let recentChatMessages = [];

let lastAction = '';
let resultSummary = ''; 

function logAndRemember(msg) {
  console.log(msg);
  if (lastAction) lastAction += '\n';
  lastAction += msg;
}

function setResult(summary) {
  resultSummary = summary;
}

//opis otoczenia wokół bota
function describeSurroundings(bot) {
  const offsets = [
    [1, 0, 0], [-1, 0, 0],
    [0, 0, 1], [0, 0, -1],
    [0, -1, 0], [0, 1, 0]
  ];
  const directions = ['prawo', 'lewo', 'przód', 'tył', 'dół', 'góra'];
  return offsets.map(([dx, dy, dz], i) => {
    const pos = bot.entity.position.offset(dx, dy, dz);
    const block = bot.blockAt(pos);
    return `- ${directions[i]}: ${block?.name || 'brak bloku'}`;
  }).join('\n');
}

async function askCohere(prompt) {
  try {
    const resp = await axios.post(
      'https://api.cohere.ai/v1/chat',
      {
        model: 'command-r-plus',
        message: prompt,
        temperature: 0.7,
        max_tokens: 100,
      },
      {
        headers: {
          Authorization: `Bearer ${COHERE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const output = resp.data.text.trim();
    const lines = output.split('\n').map(l => l.trim());
    const action = lines.find(l =>
      ['say:', 'jump', 'mine:', 'collect:', 'build', 'approach:', 'go:', 'drop:'].some(prefix => l.startsWith(prefix))
    );
    return action || 'say: (brak akcji)';
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    throw new Error(`${status || ''} ${msg}`);
  }
}

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'BotAI',
});

bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  logAndRemember('Bot się pojawił w świecie Minecraft!');
  mineflayerViewer(bot, { port: 3000, firstPerson: true });

  const defaultMovements = new Movements(bot);
  bot.pathfinder.setMovements(defaultMovements);

  setInterval(async () => {
    const nearbyPlayers = Object.keys(bot.players).filter(p => p !== bot.username).join(', ') || 'brak';
    const lastMessages = recentChatMessages.slice(-5).map(m => `- ${m}`).join('\n') || 'brak';
    const surroundings = describeSurroundings(bot);

    const prompt = `
Jesteś botem Minecrafta z AI. Twoje zadanie to rozmawiać, analizować czat i wykonywać akcje.

Dostępne akcje:
- say: <tekst>
- mine: <typ bloku>
- build
- approach: <nick>
- go: <x> <y> <z>
- drop: <nazwa_przedmiotu> [ilość]

Twoja pozycja: x=${bot.entity.position.x.toFixed(1)}, y=${bot.entity.position.y.toFixed(1)}, z=${bot.entity.position.z.toFixed(1)}
Zdrowie: ${bot.health}
Ekwipunek: ${bot.inventory.items().map(i => `${i.name}(${i.count})`).join(', ') || 'pusty'}
Gracze w pobliżu: ${nearbyPlayers}
Ostatnie wiadomości:
${lastMessages}

Otoczenie:
${surroundings}

Ostatnia wykonana akcja:
${lastAction}

Efekt ostatniej akcji:
${resultSummary}

Wygeneruj JEDNĄ akcję w jednym z powyższych formatów. Bez komentarzy ani opisu.
Możesz kilkarazy pod rząd wykonać akcję mine.
    `;

    try {
      const action = await askCohere(prompt);
      logAndRemember(`Cohere sugeruje: ${action}`);

      if (action.startsWith('go:')) {
        const parts = action.split(' ');
        if (parts.length === 4) {
          const x = parseFloat(parts[1]);
          const y = parseFloat(parts[2]);
          const z = parseFloat(parts[3]);

          if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
            await bot.pathfinder.goto(new GoalNear(x, y, z, 1));
            logAndRemember(`Dotarto do koordynat: ${x}, ${y}, ${z}`);
            const pos = bot.entity.position;
            setResult(`Obecna pozycja: x=${pos.x.toFixed(1)}, y=${pos.y.toFixed(1)}, z=${pos.z.toFixed(1)}`);
          } else {
            const err = 'Nieprawidłowe koordynaty w poleceniu go:';
            logAndRemember(err);
            setResult(err);
          }
        } else {
          const err = 'Nieprawidłowy format polecenia go:. Poprawny to: go: x y z';
          logAndRemember(err);
          setResult(err);
        }

      } else if (action === 'jump') {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 800);
        logAndRemember('Wyskoczenie');
        setResult('Bot podskoczył.');

      } else if (action.startsWith('say:')) {
        const msg = action.slice(4).trim();
        bot.chat(msg);
        logAndRemember(`Powiedziano: "${msg}"`);
        setResult(`Bot powiedział: "${msg}"`);

      } else if (action.startsWith('mine:')) {
        const blockName = action.split(':')[1].trim();
        const target = bot.findBlock({ matching: b => b.name.includes(blockName), maxDistance: 32 });
        if (target) {
          await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, 1));
          if (bot.canDigBlock(target)) {
            await bot.dig(target);
            logAndRemember(`Wykopano blok: ${target.name}`);
            setResult(`Wykopano blok: ${target.name}`);
          } else {
            const err = 'Nie można kopać tego bloku.';
            logAndRemember(err);
            setResult(err);
          }
        } else {
          const err = `Nie znaleziono bloku typu: ${blockName}`;
          logAndRemember(err);
          setResult(err);
        }

      } else if (action.startsWith('collect:')) {
        const itemType = action.split(':')[1].trim();
        const entity = Object.values(bot.entities).find(e => e.name === itemType && e.position.distanceTo(bot.entity.position) < 16);
        if (entity) {
          await bot.pathfinder.goto(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 1));
          logAndRemember(`Zebrano przedmiot: ${itemType}`);
          setResult(`Zebrano przedmiot: ${itemType}`);
        } else {
          const err = `Nie znaleziono przedmiotu do zebrania: ${itemType}`;
          logAndRemember(err);
          setResult(err);
        }

      } else if (action === 'build') {
        const pos = bot.entity.position;
        const yaw = bot.entity.yaw;
        const dx = Math.round(Math.cos(yaw));
        const dz = Math.round(Math.sin(yaw));
        const placePos = pos.offset(dx, 0, dz);
        const item = bot.inventory.items().find(i => ['dirt','stone','planks'].some(t => i.name.includes(t)));
        if (item) {
          await bot.equip(item, 'hand');
          await bot.placeBlock(bot.blockAt(placePos.offset(0, -1, 0)), { x: dx, y: 0, z: dz });
          logAndRemember(`Postawiono blok ${item.name} przed sobą`);
          setResult(`Postawiono blok ${item.name} na ${placePos.x.toFixed(1)},${placePos.y.toFixed(1)},${placePos.z.toFixed(1)}`);
        } else {
          const err = 'Brak materiału do budowy';
          logAndRemember(err);
          setResult(err);
        }

      } else if (action.startsWith('approach:')) {
        const name = action.split(':')[1].trim();
        const player = bot.players[name]?.entity;
        if (player) {
          await bot.pathfinder.goto(new GoalNear(player.position.x, player.position.y, player.position.z, 1));
          logAndRemember(`Podejście do gracza: ${name}`);
          setResult(`Bot podszedł do gracza: ${name}`);
        } else {
          const err = `Nie znaleziono gracza: ${name}`;
          logAndRemember(err);
          setResult(err);
        }

      } else if (action.startsWith('drop:')) {
        const parts = action.split(' ');
        if (parts.length >= 2) {
          const itemName = parts[1].trim();
          const amount = parts.length >= 3 ? parseInt(parts[2], 10) : null;
          const item = bot.inventory.items().find(i => i.name === itemName);
          if (!item) {
            const msg = `Nie znaleziono przedmiotu '${itemName}' w ekwipunku.`;
            logAndRemember(msg);
            setResult(msg);
          } else {
            const count = amount && amount > 0 ? Math.min(amount, item.count) : item.count;
            try {
              await bot.tossStack(item, count);
              const msg = `Wyrzucono ${count} szt. przedmiotu '${itemName}'.`;
              logAndRemember(msg);
              setResult(msg);
            } catch (err) {
              const errMsg = `Błąd podczas wyrzucania przedmiotu: ${err.message}`;
              logAndRemember(errMsg);
              setResult(errMsg);
            }
          }
        } else {
          const err = 'Nieprawidłowy format polecenia drop:. Poprawny to: drop: <nazwa_przedmiotu> [ilość]';
          logAndRemember(err);
          setResult(err);
        }
      } else {
        const msg = `Nieznana akcja: ${action}`;
        logAndRemember(msg);
        setResult(msg);
      }
    } catch (err) {
      const msg = `Błąd Cohere: ${err.message}`;
      logAndRemember(msg);
      setResult(msg);
    }
  }, 10000);
});

bot.on('chat', (username, message) => {
  if (username !== bot.username) {
    const line = `${username}: ${message}`;
    recentChatMessages.push(line);
    if (recentChatMessages.length > 10) recentChatMessages.shift();
  }
});

bot.on('error', err => logAndRemember(`Bot error: ${err}`));
bot.on('end', () => logAndRemember('Bot rozłączył się'));
