const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FLOW_NAME = process.env.FLOWISE_CHATFLOW_NAME || 'technical-engineer-rag';
const FLOW_CATEGORY = process.env.FLOWISE_CHATFLOW_CATEGORY || 'Support';
const FLOW_TYPE = process.env.FLOWISE_CHATFLOW_TYPE || 'CHATFLOW';
const FLOWISE_CONTAINER_NAME = process.env.FLOWISE_CONTAINER_NAME || '';
const templatePath = path.join(__dirname, 'technical-engineer-rag.json');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options
  });

  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || `${cmd} failed`;
    throw new Error(message);
  }

  return (result.stdout || '').trim();
}

function detectFlowiseContainer() {
  if (FLOWISE_CONTAINER_NAME) {
    return FLOWISE_CONTAINER_NAME;
  }

  const names = run('docker', [
    'ps',
    '--format',
    '{{.Names}}',
    '--filter',
    'ancestor=flowiseai/flowise:2.2.3'
  ])
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);

  if (!names.length) {
    throw new Error('No running Flowise container found.');
  }

  const composeService = names.find((name) => name.includes('flowise'));
  return composeService || names[0];
}

function loadTemplate() {
  const raw = fs.readFileSync(templatePath, 'utf8');
  const template = JSON.parse(raw);
  const githubNode = template.nodes?.find((node) => node.id === 'github_0');

  if (githubNode?.data) {
    delete githubNode.data.credential;
    githubNode.data.selected = false;
  }

  return template;
}

function buildVariableRows() {
  return [
    {
      name: 'FLOWISE_TECH_ENGINEER_REPO_LINK',
      type: 'static',
      value:
        process.env.FLOWISE_TECH_ENGINEER_REPO_LINK ||
        'https://github.com/appleidbalihar/automation/tree/master/docs/operations'
    },
    {
      name: 'FLOWISE_TECH_ENGINEER_REPO_BRANCH',
      type: 'static',
      value: process.env.FLOWISE_TECH_ENGINEER_REPO_BRANCH || 'master'
    },
    {
      name: 'FLOWISE_OPENAI_CHAT_MODEL',
      type: 'static',
      value: process.env.FLOWISE_OPENAI_CHAT_MODEL || 'gpt-4o-mini'
    },
    {
      name: 'FLOWISE_OPENAI_EMBEDDING_MODEL',
      type: 'static',
      value: process.env.FLOWISE_OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
    },
    {
      name: 'FLOWISE_OPENAI_BASEPATH',
      type: 'static',
      value: process.env.FLOWISE_OPENAI_BASEPATH || 'https://api.fuelix.ai/v1/'
    }
  ];
}

function main() {
  console.log('Preparing Flowise technical engineer RAG chatflow...');

  const containerName = detectFlowiseContainer();
  const template = loadTemplate();
  const variableRows = buildVariableRows();

  const flowDataB64 = Buffer.from(JSON.stringify(template), 'utf8').toString('base64');
  const flowVariablesB64 = Buffer.from(JSON.stringify(variableRows), 'utf8').toString('base64');

const containerScript = `
const crypto = require('crypto');
const sqlite3 = require('/usr/local/lib/node_modules/flowise/node_modules/sqlite3').verbose();

const db = new sqlite3.Database('/root/.flowise/database.sqlite');
const flowName = process.env.FLOW_NAME;
const flowCategory = process.env.FLOW_CATEGORY;
const flowType = process.env.FLOW_TYPE;
const flowData = Buffer.from(process.env.FLOW_DATA_B64, 'base64').toString('utf8');
const variableRows = JSON.parse(Buffer.from(process.env.FLOW_VARIABLES_B64, 'base64').toString('utf8'));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

async function upsertVariable(variableRow) {
  const existing = await get('SELECT id FROM variable WHERE name = ?', [variableRow.name]);
  if (existing) {
    await run(
      'UPDATE variable SET value = ?, type = ?, updatedDate = datetime(\\'now\\') WHERE id = ?',
      [variableRow.value, variableRow.type, existing.id]
    );
    return;
  }

  await run(
    'INSERT INTO variable (id, name, value, type, createdDate, updatedDate) VALUES (?, ?, ?, ?, datetime(\\'now\\'), datetime(\\'now\\'))',
    [crypto.randomUUID(), variableRow.name, variableRow.value, variableRow.type]
  );
}

async function main() {
  const existing = await get('SELECT id FROM chat_flow WHERE name = ?', [flowName]);

  if (existing) {
    await run(
      'UPDATE chat_flow SET flowData = ?, category = ?, type = ?, updatedDate = datetime(\\'now\\') WHERE id = ?',
      [flowData, flowCategory, flowType, existing.id]
    );
  } else {
    await run(
      'INSERT INTO chat_flow (id, name, flowData, deployed, isPublic, category, type, createdDate, updatedDate) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\\'now\\'), datetime(\\'now\\'))',
      [crypto.randomUUID(), flowName, flowData, 0, 0, flowCategory, flowType]
    );
  }

  for (const variableRow of variableRows) {
    await upsertVariable(variableRow);
  }

  const saved = await get('SELECT id, name, category, type, updatedDate FROM chat_flow WHERE name = ?', [flowName]);
  console.log(JSON.stringify(saved));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
`;

  const output = run(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `FLOW_NAME=${FLOW_NAME}`,
      '-e',
      `FLOW_CATEGORY=${FLOW_CATEGORY}`,
      '-e',
      `FLOW_TYPE=${FLOW_TYPE}`,
      '-e',
      `FLOW_DATA_B64=${flowDataB64}`,
      '-e',
      `FLOW_VARIABLES_B64=${flowVariablesB64}`,
      containerName,
      'node',
      '-e',
      containerScript
    ]
  );

  const saved = JSON.parse(output);
  console.log(`Seeded Flowise chatflow "${saved.name}" (${saved.id}).`);
  console.log(`Category: ${saved.category} | Type: ${saved.type}`);
  console.log('');
  console.log('Next in Flowise UI:');
  console.log('1. Open the chatflow and connect an OpenAI credential to both OpenAI nodes.');
  console.log('2. If your provider is OpenAI-compatible, set the BasePath variable or node field to your custom endpoint.');
  console.log('3. Use the built-in chat panel to ask product/support questions against the GitHub docs.');
}

main();
