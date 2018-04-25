const WebSocket = require('ws');
const fetch = require('node-fetch');
const fs = require('fs');
const unzip = require('unzip');
const ShareDB = require('@danielbuechele/sharedb/lib/client');
const {
  TOKEN_PATH,
  NUCLINO_APP_ID,
  NUCLINO_BRAIN_ID,
  NUCLINO_TEAM,
} = require('./config.js');

function getHeaders(token) {
  return {
    Cookie: `_ga=GA1.2.2136818352.1517691405; _gid=GA1.2.1271612510.1517691405; app-uid=${NUCLINO_APP_ID}; tr_p7tlufngy5={"referrer":"","query":"","variant":"production"}; token=${token}`,
    Origin: 'https://app.nuclino.com',
  };
}

async function createBackup(token) {
  console.log('Create backup');
  const fileStream = fs.createWriteStream('./backup.zip');
  return new Promise(function(resolve, reject) {
    fetch(
      `https://files.nuclino.com/export/brains/${NUCLINO_BRAIN_ID}.zip?format=md`,
      {
        method: 'GET',
        headers: getHeaders(token),
      }
    ).then(res => {
      res.body.pipe(fileStream);
    }).catch(err => {
      reject(err);
    });
    fileStream.on('end', ()=>resolve(fileStream));
    fileStream.on('error', reject); // or something like that
  });
}

function exportCell(id, title, format='pdf') {
  console.log('Exporting cell');
  fetch(
    `https://files.nuclino.com/export/cells/${id}.${format}`,
    {
      method: 'GET',
      headers: getHeaders(token),
    }
  ).then(res => {
    console.log(`downloaded cell`);
    downloaded.push(id);
    const fileStream = fs.createWriteStream(`./${title}.${format}`);
    res.body.pipe(fileStream);
  });
}

async function downloadCell(id, format='md') {
  console.log('Downloading cell');
  return await fetch(
    `https://files.nuclino.com/export/cells/${id}.${format}`,
    {
      method: 'GET',
      headers: getHeaders(token),
    }
  )
}

function updateToken() {
  const oldToken = fs
    .readFileSync(TOKEN_PATH)
    .toString()
    .trim();

  return fetch('https://api.nuclino.com/api/users/me/refresh-session', {
    method: 'POST',
    headers: {...getHeaders(oldToken), 'X-Requested-With': 'XMLHttpRequest'},
  })
    .then(res => res.headers.get('Set-Cookie'))
    .then(cookie => {
      const match = cookie.match(/token=([A-Za-z0-9+-\._]+)/);
      if (match && match.length > 0) {
        token = match[1];
        fs.writeFile(TOKEN_PATH, token, 'utf8');
      }
      return token;
    });
}

const leafDownloadLimit = 10;
const visited = [];
const resolved = [];
const requested = [];
const downloaded = [];
const titles = {};
let treeData = {};

function traverseTree(connection, id, treeNode, depth = 0) {
  if (titles[id]) {
    treeNode.title = titles[id];
    return;
  }
  visited.push(id);
  subscribeCell(connection, id, cell => {
    const cellTitle = `${cell.data.title}`;
    console.log(`${" ".repeat(depth)}${cellTitle} - ${id}`);
    resolved.push(id);
    titles[id] = cell.data.title;
    treeNode.title = cell.data.title;  
    treeNode.kind = cell.data.kind;  
    cell.data.childIds.map(id => {
      const childNode = {
        id,
        title: id,
        kind: '',
        children: []
      };
      treeNode.children.push(childNode)
      traverseTree(connection, id, childNode, depth + 1)
    });
    // If there are no more children, check to see if
    // we have resolved everything we know about.
    if (cell.data.childIds.length === 0 && resolved.length === visited.length) {
      console.log("*** Completed Downloading Tree Information");
      console.log(`*** We've resolved ${resolved.length} from ${visited.length} nodes identified.`)
      download();
    }
  });
}

async function download() {
  const fileStream = fs.createWriteStream('./Export.md');
  await downloadTree(treeData, fileStream);
  console.log("download finished");
  fileStream.end();
}

async function downloadTree(treeNode, fileStream) {
  fileStream.write(`#${treeNode.title}\n`);
  if (treeNode.kind === 'LEAF') {
    if (requested.length >= leafDownloadLimit) {
      return;
    }
    requested.push(treeNode.id);
    try {
      const res = await downloadCell(treeNode.id);
      console.log("finished");
      res.body.pipe(fileStream, { end: false });
    } catch (e) {
      console.log("error", e);
    }
  }
  for (let childNode of treeNode.children) {
    await downloadTree(childNode, fileStream);
  }
}

function subscribeBrain(connection) {
  const brain = connection.get('ot_brain', NUCLINO_BRAIN_ID);

  brain.subscribe();
  brain.on('load', () => {
    //console.log(brain.data.mainCellId);
    console.log("*** Started Downloading Tree Information");
    treeData = {
      id: brain.data.mainCellId,
      title: brain.data.title,
      kind: 'BRAIN',
      children: []
    }
    traverseTree(connection, brain.data.mainCellId, treeData);
  });
}

const cells = {};
function subscribeCell(connection, name, cb) {
  //console.log('subscribe ' + name);
  const cell = connection.get('ot_cell', name);
  cell.subscribe();
  cells[name] = cell;
  if (typeof cb === 'function') {
    cell.on('load', () => cb(cell));
  }
}


let killProcess = null;
async function startWatching() {
  const token = await updateToken();

  const fileStream = await createBackup(token);
  console.log("downloaded");
  fs.createReadStream('./backup.zip').pipe(unzip.Extract({ path: './markdown' }));

  const socket = new WebSocket('wss://api.nuclino.com/syncing', {
    headers: getHeaders(token),
  });

  const connection = new ShareDB.Connection(socket);
  connection.on('state', state => {
    //console.log(`new connection state: ${state}`);
    if (state === 'connected') {
      subscribeBrain(connection);
    } else if (state === 'disconnected') {
      startWatching();
    }
  });

  /*

  // restart every day to renew token
  if (!killProcess) {
    killProcess = setTimeout(() => process.exit(1), 24 * 60 * 60 * 1000);
  } */
}

startWatching();