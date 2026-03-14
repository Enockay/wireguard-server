#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const rootDir = __dirname;
const modelsDir = path.join(rootDir, "models");

function getMongoUri() {
  return (
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/wireguard"
  );
}

function loadAllModels() {
  const modelFiles = fs
    .readdirSync(modelsDir)
    .filter((file) => file.endsWith(".js"))
    .sort();

  for (const file of modelFiles) {
    require(path.join(modelsDir, file));
  }

  return mongoose.models;
}

function isPathRequired(schemaType) {
  if (!schemaType || typeof schemaType.isRequired !== "function") {
    return false;
  }

  try {
    return schemaType.isRequired === true || schemaType.isRequired();
  } catch {
    return Boolean(schemaType.options && schemaType.options.required);
  }
}

function setDeep(target, dottedPath, value) {
  const parts = dottedPath.split(".");
  let cursor = target;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (
      cursor[part] === undefined ||
      cursor[part] === null ||
      typeof cursor[part] !== "object"
    ) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }

  cursor[parts[parts.length - 1]] = value;
}

function makeStringValue(pathName, index, prefix) {
  const key = pathName.toLowerCase();

  if (key.includes("email")) return `${prefix}.${String(index).padStart(2, "0")}@seed.mikrotik.local`;
  if (key.includes("password")) return "Password123!";
  if (key.includes("first") && key.includes("name")) return `${prefix === "admin" ? "Admin" : "Test"}${index}`;
  if (key.includes("last") && key.includes("name")) return "Operator";
  if (key === "name" || key.endsWith(".name")) return prefix === "admin" ? "System Administrator" : `Test User ${String(index).padStart(2, "0")}`;
  if (key.includes("username")) return `${prefix}_user_${String(index).padStart(2, "0")}`;
  if (key.includes("phone")) return `+1555000${String(index).padStart(4, "0")}`;
  if (key.includes("ip")) return `10.66.${Math.floor(index / 200)}.${(index % 200) + 10}`;
  if (key.includes("endpoint")) return `seed-router-${index}.mikrotik.local`;
  if (key.includes("publickey")) return `seed-public-key-${prefix}-${index}`;
  if (key.includes("privatekey")) return `seed-private-key-${prefix}-${index}`;
  if (key.includes("server")) return `Server ${index}`;
  if (key.includes("ticket")) return `TICKET-${String(index).padStart(4, "0")}`;
  if (key.includes("city")) return "Nairobi";
  if (key.includes("country")) return "Kenya";
  if (key.includes("address")) return `Seed address ${index}`;
  if (key.includes("notes") || key.includes("description")) return `Generated seed data for ${pathName}`;
  if (key.includes("title") || key.includes("subject")) return `Seed ${prefix} record ${index}`;
  if (key.includes("code")) return `${prefix.toUpperCase()}${String(index).padStart(6, "0")}`;

  return `${prefix}-${pathName.replace(/\./g, "-")}-${index}`;
}

function makeNumberValue(pathName, index) {
  const key = pathName.toLowerCase();

  if (key.includes("port")) return 20000 + index;
  if (key.includes("amount") || key.includes("price") || key.includes("cost")) return 1000 + index * 25;
  if (key.includes("days")) return 30;
  if (key.includes("limit")) return 10;
  if (key.includes("traffic") || key.includes("bytes")) return 1024 * 1024 * (index + 1);

  return index + 1;
}

function resolveEnumValue(schemaType, fallback) {
  const enumValues = schemaType?.enumValues || schemaType?.options?.enum || [];
  if (!Array.isArray(enumValues) || enumValues.length === 0) return fallback;
  if (enumValues.includes("admin")) return "admin";
  if (enumValues.includes("user")) return "user";
  if (enumValues.includes("active")) return "active";
  return enumValues[0];
}

function buildDocument(model, preferredValues, refs, index, prefix) {
  const document = {};

  model.schema.eachPath((pathName, schemaType) => {
    if (
      pathName === "_id" ||
      pathName === "__v" ||
      pathName.includes("$*") ||
      pathName.endsWith(".$")
    ) {
      return;
    }

    if (preferredValues[pathName] !== undefined) {
      setDeep(document, pathName, preferredValues[pathName]);
      return;
    }

    if (!isPathRequired(schemaType)) return;

    const instance = schemaType.instance;
    const refName = schemaType.options && schemaType.options.ref;

    if (refName && refs[refName] && refs[refName].length > 0) {
      setDeep(document, pathName, refs[refName][index % refs[refName].length]);
      return;
    }

    if (instance === "String") {
      setDeep(document, pathName, resolveEnumValue(schemaType, makeStringValue(pathName, index, prefix)));
      return;
    }

    if (instance === "Number") {
      setDeep(
        document,
        pathName,
        schemaType.options?.min !== undefined
          ? Math.max(schemaType.options.min, makeNumberValue(pathName, index))
          : makeNumberValue(pathName, index),
      );
      return;
    }

    if (instance === "Boolean") {
      setDeep(document, pathName, false);
      return;
    }

    if (instance === "Date") {
      setDeep(document, pathName, new Date());
      return;
    }

    if (instance === "ObjectId") {
      setDeep(document, pathName, new mongoose.Types.ObjectId());
      return;
    }

    if (instance === "Array") {
      setDeep(document, pathName, []);
      return;
    }

    setDeep(document, pathName, {});
  });

  return document;
}

function makeUserBase(index, role) {
  const isAdmin = role === "admin";
  const displayIndex = isAdmin ? 1 : index;

  return {
    email: isAdmin
      ? "admin@seed.mikrotik.local"
      : `user${String(displayIndex).padStart(2, "0")}@seed.mikrotik.local`,
    password: "Password123!",
    name: isAdmin
      ? "Seed Admin"
      : `Seed User ${String(displayIndex).padStart(2, "0")}`,
    firstName: isAdmin ? "Seed" : "Test",
    lastName: isAdmin ? "Admin" : `User${String(displayIndex).padStart(2, "0")}`,
    username: isAdmin ? "seedadmin" : `seeduser${String(displayIndex).padStart(2, "0")}`,
    phone: `+155510${String(displayIndex).padStart(4, "0")}`,
    role,
    isActive: true,
    active: true,
    status: "active",
    emailVerified: true,
    verified: true,
    country: "Kenya",
    city: "Nairobi",
    address: `Seed user address ${displayIndex}`,
    referralCode: `${isAdmin ? "ADM" : "USR"}${String(displayIndex).padStart(6, "0")}`,
  };
}

function makeClientBase(index, ownerId) {
  return {
    name: `VPN Client ${String(index).padStart(2, "0")}`,
    userId: ownerId,
    owner: ownerId,
    user: ownerId,
    assignedUser: ownerId,
    email: `client${String(index).padStart(2, "0")}@seed.mikrotik.local`,
    privateKey: `seed-client-private-key-${index}`,
    publicKey: `seed-client-public-key-${index}`,
    presharedKey: `seed-client-psk-${index}`,
    address: `10.8.0.${index + 1}/32`,
    allowedIPs: ["0.0.0.0/0"],
    dns: ["1.1.1.1", "8.8.8.8"],
    enabled: true,
    isActive: true,
    active: true,
    status: "active",
    description: `Generated client profile ${index}`,
  };
}

function makeRouterBase(index, ownerId) {
  return {
    name: `MikroTik Router ${String(index).padStart(2, "0")}`,
    userId: ownerId,
    owner: ownerId,
    user: ownerId,
    routerId: `RTR-${String(index).padStart(4, "0")}`,
    ipAddress: `172.16.10.${index + 10}`,
    vpnIp: `10.50.0.${index + 10}`,
    endpoint: `router-${index}.seed.mikrotik.local`,
    publicKey: `seed-router-public-key-${index}`,
    privateKey: `seed-router-private-key-${index}`,
    sshPort: 2200 + index,
    winboxPort: 8290 + index,
    apiPort: 8728 + index,
    enabled: true,
    isActive: true,
    active: true,
    status: "active",
    notes: `Generated MikroTik router ${index}`,
  };
}

async function deleteSeededDocs(model) {
  const filter = {
    $or: [
      { email: /@seed\.mikrotik\.local$/i },
      { username: /^seed/i },
      { referralCode: /^ADM|^USR/ },
      { name: /^Seed / },
      { routerId: /^RTR-/ },
    ],
  };

  try {
    await model.deleteMany(filter);
  } catch {
    // best effort only
  }
}

async function seedUsers(User) {
  await deleteSeededDocs(User);

  const createdUsers = [];

  for (let index = 1; index <= 21; index += 1) {
    const role = index === 1 ? "admin" : "user";
    const preferred = makeUserBase(index === 1 ? 1 : index - 1, role);
    const document = buildDocument(
      User,
      preferred,
      {},
      index,
      role === "admin" ? "admin" : "user",
    );
    const created = await User.create(document);
    createdUsers.push(created);
  }

  return {
    admin: createdUsers[0],
    users: createdUsers.slice(1),
    allIds: createdUsers.map((user) => user._id),
  };
}

async function seedClients(Client, userIds) {
  if (!Client) return [];

  await deleteSeededDocs(Client);

  const clients = [];
  const refs = { User: userIds };

  for (let index = 1; index <= 12; index += 1) {
    const ownerId = userIds[index % userIds.length];
    const document = buildDocument(
      Client,
      makeClientBase(index, ownerId),
      refs,
      index,
      "client",
    );
    clients.push(await Client.create(document));
  }

  return clients;
}

async function seedRouters(MikrotikRouter, userIds) {
  if (!MikrotikRouter) return [];

  await deleteSeededDocs(MikrotikRouter);

  const routers = [];
  const refs = { User: userIds };

  for (let index = 1; index <= 8; index += 1) {
    const ownerId = userIds[index % userIds.length];
    const document = buildDocument(
      MikrotikRouter,
      makeRouterBase(index, ownerId),
      refs,
      index,
      "router",
    );
    routers.push(await MikrotikRouter.create(document));
  }

  return routers;
}

async function main() {
  const mongoUri = getMongoUri();
  await mongoose.connect(mongoUri);

  const models = loadAllModels();
  const User = models.User;
  const Client = models.Client;
  const MikrotikRouter = models.MikrotikRouter;

  if (!User) {
    throw new Error("User model was not found. Seed aborted.");
  }

  const seededUsers = await seedUsers(User);
  const seededClients = await seedClients(Client, seededUsers.allIds);
  const seededRouters = await seedRouters(MikrotikRouter, seededUsers.allIds);

  console.log("Seed complete");
  console.log("------------------------------");
  console.log(`Mongo URI: ${mongoUri}`);
  console.log("Admin login: admin@seed.mikrotik.local / Password123!");
  console.log(`Regular users created: ${seededUsers.users.length}`);
  console.log(`Clients created: ${seededClients.length}`);
  console.log(`Routers created: ${seededRouters.length}`);
  console.log("------------------------------");
}

main()
  .catch((error) => {
    console.error("Seed failed");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
