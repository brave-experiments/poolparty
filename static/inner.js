
/*
Pool interface

{
  constructor (browser, recordFunction)
  log(),
  consume(max),
  release(max),
  held(),
  listSize,
  maxSlots,
  maxValue,
  pulseMs,
  settlingTimeMs
}
*/

// Default websocket address
const kWebSocketAddress = "wss://poolparty.privacytests.org/websockets";

class SocketPool {
  constructor (browser, recordFunction) {
    this.log = () => recordFunction(this.held());
    const constants = {
      Chrome: {
        listSize: 5,
        maxSlots: 255,
        maxValue: 128,
        pulseMs: 50,
        settlingTimeMs: 0
      },
      Firefox: {
        listSize: 5,
        maxSlots: 255,
        maxValue: 128,
        pulseMs: 350, // 500,
        settlingTimeMs: 50
      }
    }[browser];
    Object.assign(this, constants);
    this.numBits = this.listSize * Math.log(this.maxValue) / Math.log(2);
  }

  // All sockets, dead or alive (though we try to remove
  // dead sockets quickly).
  _sockets = new Set();

  // Return the number of sockets currently held.
  held () {
    return this._sockets.size;
  }

  async consumeOne () {
    const socket = new WebSocket(kWebSocketAddress);
    this._sockets.add(socket);
  }

  async releaseOne () {
    const socket = this._sockets.values().next().value;
    socket.close();
    this._sockets.delete(socket);
  }

  collectGarbage () {
    for (const socket of this._sockets) {
      if (socket.readyState === 3) {
        this._sockets.delete(socket);
      }
    }
  }
};

// Figure out the current browser.
const kBrowser = (() => {
  if (navigator.userAgent.indexOf("Chrome") >= 0) {
    return "Chrome";
  } else if (navigator.userAgent.indexOf("Firefox") >= 0) {
    return "Firefox";
  }
  return null;
})();

const params = new URLSearchParams(window.location.search);
const debug = params.get("debug") === "true";

let trace = [];

const recordIntegerToTrace = (i) => {
  trace.push([Date.now(), i]);
};

// Convert a list of small integers to a big integer
const listToBigInteger = (list, listSize, maxSmallInteger) => {
  let result = 0;
  for (let i = listSize - 1; i >= 0; --i) {
    result = result * maxSmallInteger + list[i];
  }
  return result;
};

// Convert a big integer to a list of small integers
const bigIntegerToList = (bigInteger, listSize, maxSmallInteger) => {
  const list = [];
  let feed = bigInteger;
  for (let i = 0; i < listSize; ++i) {
    const remainder = feed % maxSmallInteger;
    list.push(remainder);
    feed = (feed - remainder) / maxSmallInteger;
  }
  return list;
};

// Convert a big integer to a hexadecimal string
const bigIntegerToHex = (bigInteger, numBits) => {
  const nHexDigits = Math.ceil(numBits / 4);
  return (bigInteger + Math.pow(16, nHexDigits)).toString(16).slice(1);
};

// Generate a random big integer for sending between tabs.
const randomBigInteger = (numBits) => Math.floor(Math.random() * Math.pow(2, numBits));

// Sleep for time specified by interval in ms.
const sleepMs = (interval) => new Promise(
  resolve => setTimeout(resolve, interval));

// Sleep until a time in the future relative to `Date.now()`.
const sleepUntil = async (timeMs) => {
  await sleepMs(timeMs - Date.now());
  return Date.now();
};

// Consume and return number consumed.
const consume = async (pool, max) => {
  pool.log();
  const nStart = pool.held();
  for (let i = 0; i < max; ++i) {
    pool.consumeOne();
    pool.log();
  }
  await sleepMs(pool.settlingTimeMs);
  pool.collectGarbage();
  const nFinish = pool.held();
  pool.log();
  return nFinish - nStart;
};

// Release up to max, and return number released.
const release = async (pool, max) => {
  pool.log();
  if (max === 0) {
    return 0;
  }
  const numberToRelease = Math.min(max, pool.held());
  for (let i = 0; i < numberToRelease; ++i) {
    pool.releaseOne();
    pool.log();
  }
  await sleepMs(pool.settlingTimeMs);
  pool.log();
  return numberToRelease;
};

// Probe for unheld slots.
const probe = async (pool, max) => {
  const consumedCount = await consume(pool, max);
  await release(pool, consumedCount);
  return consumedCount;
};

// Return true if we have taken the sender role;
// false if we are a receiver.
const isSender = async (pool) => {
  await release(pool, pool.held());
  await consume(pool, pool.maxSlots);
  //  console.log(`pool.held(): ${pool.held()} vs ${pool.maxSlots/2}`);
  if (pool.held() < pool.maxSlots / 2) {
    await release(pool, pool.held());
    return false;
  } else {
    return true;
  }
};

// Send a big integer.
const sendInteger = async (pool, bigInteger, startTime) => {
  const list = bigIntegerToList(bigInteger, pool.listSize, pool.maxValue);
  await consume(pool, pool.maxSlots - pool.held());
  let lastInteger = 0;
  for (let i = 0; i < pool.listSize; ++i) {
    await sleepUntil(startTime + (i + 1) * pool.pulseMs);
    // At the beginng of each pulse, either consume
    // or release slots so that, for the rest of the pulse,
    // exactly `integer + 1` slots are unheld.
    const integer = 1 + list[i];
    if (kBrowser === "Firefox") {
      await consume(pool, lastInteger + 5);
      await release(pool, integer);
    } else {
      const delta = integer - lastInteger;
      if (delta > 0) {
        await release(pool, delta);
      } else {
        await consume(pool, -delta);
      }
    }
    lastInteger = integer;
  }
  if (debug) {
    log(list);
  }
  // return list;
  return bigIntegerToHex(bigInteger, pool.numBits);
};

// Receive a big integer.
const receiveInteger = async (pool, startTime) => {
  const integerList = [];
  // Read n integers by probing for
  // unheld slots.
  for (let i = 0; i < pool.listSize; ++i) {
    await sleepUntil(startTime + (i + 1.25) * pool.pulseMs);
    const integer = await probe(pool, pool.maxValue);
    integerList.push(integer - 1);
  }
  if (debug) {
    log(integerList);
  }
  // return integerList;
  return bigIntegerToHex(listToBigInteger(integerList, pool.listSize, pool.maxValue), pool.numBits);
};

// A div containing a log of work done
const logDiv = document.getElementById("log");

// Round to the nearest 1000th of a second and express in seconds
const roundTime = (timeMs) => Math.round(timeMs) / 1000;

// Add a message to log, included elapsed time and
// how many slots we are holding.
const log = (msg, elapsedMs) => {
  let text = roundTime(performance.now()) + " | " + msg;
  if (elapsedMs !== undefined) {
    text += `, elapsed, ms: ${Math.round(elapsedMs)}`;
  }
  text += "\n";
  logDiv.innerText += text;
  window.scrollBy(0, logDiv.scrollHeight);
};

// Wait until the next second begins according to
// the system clock.
const sleepUntilNextRoundInterval = async (interval) => {
  return sleepUntil(Math.ceil(Date.now() / interval) * interval);
};

// When page loads
const run = async (pool) => {
  trace = [];
  for (let i = 0; i < 10; ++i) {
    pool.log();
    const t0 = await sleepUntilNextRoundInterval((1 + pool.listSize) * pool.pulseMs);
    pool.log();
    const sender = await isSender(pool);
    if (sender) {
      const t1 = performance.now();
      const resultList = await sendInteger(pool, randomBigInteger(pool.numBits), t0);
      const t2 = performance.now();
      log(`send: ${resultList}`, t2 - t1);
    } else {
      const t1 = performance.now();
      const resultList = await receiveInteger(pool, t0);
      const t2 = performance.now();
      log(`receive: ${resultList}`, t2 - t1);
    }
  }
  pool.log();
  console.log(JSON.stringify(trace));
};

// A div containing the command buttons.
const commandButtonsDiv = document.getElementById("commandButtons");

// Create a command button wired to command.
const createButtonForCommand = (commandName, commandFunction) => {
  const button = document.createElement("button");
  button.id = "button-" + commandName.replace(" ", "-"); ;
  button.innerText = commandName;
  button.addEventListener("click", async (_e) => {
    const t1 = performance.now();
    const result = await commandFunction();
    const t2 = performance.now();
    log(`${commandName}: ${result}`, t2 - t1);
  });
  commandButtonsDiv.appendChild(button);
};

// Create all the command buttons.
const createAllCommandButtons = (pool) => {
  createButtonForCommand("consume 1", () => consume(pool, 1));
  createButtonForCommand("consume all", () => consume(pool, pool.maxSlots * 2));
  createButtonForCommand("release 1", () => release(pool, 1));
  createButtonForCommand("release all", () => release(pool, pool.held()));
  createButtonForCommand("probe", () => probe(pool, pool.maxSlots));
  createButtonForCommand("is sender", () => isSender(pool));
  createButtonForCommand("send", () => sendInteger(pool, randomBigInteger(pool.numBits), 0));
  createButtonForCommand("receive", () => receiveInteger(pool));
};

// The main program.

const main = async () => {
  const pool = new SocketPool(kBrowser, recordIntegerToTrace);
  if (debug) {
    createAllCommandButtons(pool);
  } else {
    await run(pool);
  }
};

main();
