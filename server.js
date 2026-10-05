require("dotenv").config();

const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const QRCode = require("qrcode");

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === "production";
const root = __dirname;
const dataDirectory = path.join(root, "data");
fs.mkdirSync(dataDirectory, { recursive: true });

const catalog = new Map([
  ["Virginia Fonseca #202", { id: "Virginia Fonseca #202", name: "Virginia Fonseca #202", priceInCents: 39990, weightGrams: 450 }],
  ["Zé Felipe #203", { id: "Zé Felipe #203", name: "Zé Felipe #203", priceInCents: 19990, weightGrams: 450 }],
  ["Pedro Dom #101", { id: "Pedro Dom #101", name: "Felipe Bragança como Pedro Dom #101", priceInCents: 19990, weightGrams: 450 }],
  ["Adriana Esteves #531", { id: "Adriana Esteves #531", name: "Adriana Esteves #531", priceInCents: 28990, weightGrams: 450 }],
  ["Simone Mendes #31", { id: "Simone Mendes #31", name: "Simone Mendes #31", priceInCents: 19990, weightGrams: 450 }],
  ["Veigh #148", { id: "Veigh #148", name: "Veigh #148", priceInCents: 29990, weightGrams: 450 }],
]);

const database = new Database(path.join(dataDirectory, "geekzone.sqlite"));
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expire ON sessions(expire);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    public_code TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES customers(id),
    status TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    payment_id TEXT,
    payment_provider TEXT,
    payment_qr_code TEXT,
    payment_qr_base64 TEXT,
    payment_expires_at TEXT,
    payment_confirmed_at TEXT,
    subtotal_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    shipping_service TEXT NOT NULL,
    shipping_days INTEGER NOT NULL,
    tracking_code TEXT,
    address_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS return_requests (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    user_id TEXT NOT NULL REFERENCES customers(id),
    reason TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_user_created ON orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS returns_order_created ON return_requests(order_id, created_at DESC);
`);

const orderColumns = new Set(
  database.prepare("PRAGMA table_info(orders)").all().map((column) => column.name),
);
for (const [name, type] of [
  ["payment_provider", "TEXT"],
  ["payment_qr_code", "TEXT"],
  ["payment_qr_base64", "TEXT"],
  ["payment_expires_at", "TEXT"],
  ["payment_confirmed_at", "TEXT"],
]) {
  if (!orderColumns.has(name)) database.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
}

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  console.error("SESSION_SECRET deve conter pelo menos 32 caracteres. Configure o .env.");
  process.exit(1);
}

if (production && (!process.env.APP_URL || !process.env.APP_URL.startsWith("https://"))) {
  console.error("APP_URL precisa ser HTTPS em producao.");
  process.exit(1);
}

app.disable("x-powered-by");
if (production) app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", "https://viacep.com.br"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  express.json({
    limit: "32kb",
    verify(request, _response, buffer) {
      request.rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(
  session({
    name: "geekzone.sid",
    secret: sessionSecret,
    store: new (class extends session.Store {
      constructor() {
        super();
        this.getStatement = database.prepare("SELECT sess, expire FROM sessions WHERE sid = ?");
        this.setStatement = database.prepare(`
          INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
        `);
        this.touchStatement = database.prepare("UPDATE sessions SET expire = ? WHERE sid = ?");
        this.deleteStatement = database.prepare("DELETE FROM sessions WHERE sid = ?");
        this.purgeStatement = database.prepare("DELETE FROM sessions WHERE expire <= ?");
        this.lastPurge = 0;
      }

      get(id, callback) {
        try {
          const record = this.getStatement.get(id);
          if (!record) return callback(null, null);
          if (record.expire <= Date.now()) {
            this.deleteStatement.run(id);
            return callback(null, null);
          }
          callback(null, JSON.parse(record.sess));
        } catch (error) {
          callback(error);
        }
      }

      set(id, value, callback = () => {}) {
        try {
          const expires = value.cookie?.expires
            ? new Date(value.cookie.expires).getTime()
            : Date.now() + 7 * 24 * 60 * 60 * 1000;
          this.setStatement.run(id, JSON.stringify(value), expires);
          if (Date.now() - this.lastPurge > 60 * 60 * 1000) {
            this.purgeStatement.run(Date.now());
            this.lastPurge = Date.now();
          }
          callback(null);
        } catch (error) {
          callback(error);
        }
      }

      touch(id, value, callback = () => {}) {
        try {
          const expires = value.cookie?.expires
            ? new Date(value.cookie.expires).getTime()
            : Date.now() + 7 * 24 * 60 * 60 * 1000;
          this.touchStatement.run(expires, id);
          callback(null);
        } catch (error) {
          callback(error);
        }
      }

      destroy(id, callback = () => {}) {
        try {
          this.deleteStatement.run(id);
          callback(null);
        } catch (error) {
          callback(error);
        }
      }
    })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: production,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Limite de cadastros atingido. Tente novamente mais tarde." },
});
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Muitos pedidos de pagamento. Aguarde alguns minutos e tente novamente." },
});

function sendError(response, status, message) {
  return response.status(status).json({ error: message });
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function requireCsrf(request, response, next) {
  const supplied = request.get("x-csrf-token") || "";
  const expected = request.session.csrfToken || "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  const valid =
    suppliedBuffer.length > 0 &&
    suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (!valid) return sendError(response, 403, "Sessao expirada. Atualize a pagina e tente novamente.");
  next();
}

function requireUser(request, response, next) {
  if (!request.session.userId) return sendError(response, 401, "Entre na sua conta para continuar.");
  next();
}

function requireAdmin(request, response, next) {
  const configured = process.env.ADMIN_API_KEY || "";
  const supplied = (request.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (
    !configured ||
    !supplied ||
    Buffer.byteLength(configured) !== Buffer.byteLength(supplied) ||
    !crypto.timingSafeEqual(Buffer.from(configured), Buffer.from(supplied))
  ) {
    return sendError(response, 401, "Acesso administrativo nao autorizado.");
  }
  next();
}

function regenerateSession(request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(request) {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function validEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function validAddress(address) {
  const states = new Set([
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
    "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
    "SP", "SE", "TO",
  ]);
  return (
    address &&
    typeof address === "object" &&
    typeof address.name === "string" &&
    address.name.trim().length >= 3 &&
    typeof address.phone === "string" &&
    address.phone.replace(/\D/g, "").length >= 10 &&
    /^[0-9]{5}-?[0-9]{3}$/.test(address.postalCode || "") &&
    typeof address.street === "string" &&
    address.street.trim().length >= 2 &&
    typeof address.number === "string" &&
    address.number.trim().length > 0 &&
    typeof address.district === "string" &&
    address.district.trim().length >= 2 &&
    typeof address.city === "string" &&
    address.city.trim().length >= 2 &&
    states.has(address.state)
  );
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > catalog.size) {
    throw new Error("Carrinho vazio ou invalido.");
  }
  const unique = new Map();
  for (const item of items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !catalog.has(item.id) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 20 ||
      unique.has(item.id)
    ) {
      throw new Error("O carrinho contem um produto ou quantidade invalida.");
    }
    unique.set(item.id, { product: catalog.get(item.id), quantity: item.quantity });
  }
  return [...unique.values()];
}

function getConfiguredCorreios() {
  const required = [
    "CORREIOS_USER",
    "CORREIOS_ACCESS_CODE",
    "CORREIOS_POSTAL_CARD",
    "CORREIOS_ORIGIN_CEP",
    "CORREIOS_PACKAGE_LENGTH_CM",
    "CORREIOS_PACKAGE_WIDTH_CM",
    "CORREIOS_PACKAGE_HEIGHT_CM",
    "CORREIOS_ITEM_WEIGHT_GRAMS",
    "CORREIOS_SERVICE_CODES",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    const error = new Error(`Frete dos Correios ainda nao configurado: ${missing.join(", ")}.`);
    error.status = 503;
    throw error;
  }

  const dimensions = [
    Number(process.env.CORREIOS_PACKAGE_LENGTH_CM),
    Number(process.env.CORREIOS_PACKAGE_WIDTH_CM),
    Number(process.env.CORREIOS_PACKAGE_HEIGHT_CM),
    Number(process.env.CORREIOS_ITEM_WEIGHT_GRAMS),
  ];
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    const error = new Error("Configure dimensoes e peso reais da embalagem no .env.");
    error.status = 503;
    throw error;
  }

  return {
    user: process.env.CORREIOS_USER,
    accessCode: process.env.CORREIOS_ACCESS_CODE,
    card: process.env.CORREIOS_POSTAL_CARD,
    originCep: process.env.CORREIOS_ORIGIN_CEP.replace(/\D/g, ""),
    length: dimensions[0],
    width: dimensions[1],
    height: dimensions[2],
    itemWeight: dimensions[3],
    serviceCodes: process.env.CORREIOS_SERVICE_CODES.split(",").map((code) => code.trim()).filter(Boolean),
  };
}

function getFixedShippingQuote() {
  const amountValue = process.env.SHIPPING_FLAT_RATE_CENTS?.trim();
  const daysValue = process.env.SHIPPING_FLAT_RATE_DAYS?.trim();
  const amount = Number(amountValue);
  const deliveryDays = Number(daysValue);
  if (
    !amountValue ||
    !daysValue ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(deliveryDays) ||
    deliveryDays < 1
  ) {
    const error = new Error(
      "Frete fixo nao configurado. Defina SHIPPING_FLAT_RATE_CENTS e SHIPPING_FLAT_RATE_DAYS no .env.",
    );
    error.status = 503;
    throw error;
  }
  return {
    serviceCode: "FIXED",
    name: "Entrega padrão",
    shippingCents: amount,
    deliveryDays,
  };
}

function getFreeShippingQuote() {
  return {
    serviceCode: "FREE",
    name: "Frete grátis para todo o Brasil",
    shippingCents: 0,
    deliveryDays: 0,
  };
}

function normalizePixMerchantField(value, maxLength, fieldName) {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (!normalized || normalized.length > maxLength) {
    const error = new Error(`${fieldName} precisa ter entre 1 e ${maxLength} caracteres sem acentos.`);
    error.status = 503;
    throw error;
  }
  return normalized;
}

function pixField(id, value) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > 99) {
    const error = new Error("A chave Pix configurada excede o limite aceito pelo QR Code.");
    error.status = 503;
    throw error;
  }
  return `${id}${String(byteLength).padStart(2, "0")}${value}`;
}

function hasValidCpfCheckDigits(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(digits[9]) && digit(10) === Number(digits[10]);
}

function hasValidCnpjCheckDigits(digits) {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const calculateDigit = (source, weights) => {
    const remainder = source
      .split("")
      .reduce((sum, value, index) => sum + Number(value) * weights[index], 0) % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = calculateDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calculateDigit(digits.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(digits[12]) && second === Number(digits[13]);
}

function validatePixKey(pixKey) {
  const digits = pixKey.replace(/\D/g, "");
  const isUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(pixKey);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixKey) && Buffer.byteLength(pixKey) <= 77;
  const isBrazilianPhone = /^\+55[1-9][1-9]\d{8,9}$/.test(pixKey);
  if (
    isUuid ||
    isEmail ||
    isBrazilianPhone ||
    hasValidCpfCheckDigits(digits) ||
    hasValidCnpjCheckDigits(digits)
  ) {
    return;
  }

  const error = new Error(
    /^\d{11}$/.test(digits)
      ? "A chave Pix configurada parece ser um CPF com digitos verificadores invalidos. Confira a chave cadastrada no banco e atualize o .env."
      : /^\d{14}$/.test(digits)
        ? "A chave Pix configurada parece ser um CNPJ com digitos verificadores invalidos. Confira a chave cadastrada no banco e atualize o .env."
        : "A chave Pix configurada nao parece ser um CPF/CNPJ valido, telefone com codigo +55, e-mail ou chave aleatoria UUID. Confira o formato no banco.",
  );
  error.status = 503;
  throw error;
}

function pixCrc16(value) {
  let crc = 0xffff;
  for (const byte of Buffer.from(value, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function createDirectPixPayload({ totalCents, publicCode }) {
  const pixKey = process.env.PIX_KEY?.trim();
  if (!pixKey) {
    const error = new Error("Pix direto ainda nao esta configurado. Cadastre sua chave e os dados do recebedor no .env.");
    error.status = 503;
    throw error;
  }
  validatePixKey(pixKey);
  const amount = (totalCents / 100).toFixed(2);
  const merchantName = normalizePixMerchantField(
    process.env.PIX_MERCHANT_NAME?.trim() || "",
    25,
    "PIX_MERCHANT_NAME",
  );
  const merchantCity = normalizePixMerchantField(
    process.env.PIX_MERCHANT_CITY?.trim() || "",
    15,
    "PIX_MERCHANT_CITY",
  );
  const merchantAccount = [
    pixField("00", "br.gov.bcb.pix"),
    pixField("01", pixKey),
  ].join("");
  const additionalData = pixField("05", publicCode.replace(/[^A-Za-z0-9]/g, "").slice(0, 25));
  const payload = [
    pixField("00", "01"),
    pixField("01", "11"),
    pixField("26", merchantAccount),
    pixField("52", "0000"),
    pixField("53", "986"),
    pixField("54", amount),
    pixField("58", "BR"),
    pixField("59", merchantName),
    pixField("60", merchantCity),
    pixField("62", additionalData),
    "6304",
  ].join("");
  return `${payload}${pixCrc16(payload)}`;
}

async function createDirectPixQr({ totalCents, publicCode }) {
  const payload = createDirectPixPayload({ totalCents, publicCode });
  const qrCodeBase64 = (await QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
    type: "image/png",
  })).split(",")[1];
  return { payload, qrCodeBase64 };
}

let correiosTokenCache;
async function getCorreiosToken(configuration) {
  if (correiosTokenCache && correiosTokenCache.expiresAt > Date.now() + 60_000) {
    return correiosTokenCache.token;
  }

  const authorization = Buffer.from(`${configuration.user}:${configuration.accessCode}`).toString("base64");
  const response = await fetch("https://api.correios.com.br/token/v1/autentica/cartaopostagem", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ numero: configuration.card }),
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.token) {
    const error = new Error("Nao foi possivel autenticar nas APIs dos Correios. Confira contrato e credenciais.");
    error.status = 502;
    throw error;
  }

  correiosTokenCache = {
    token: result.token,
    expiresAt: result.expiraEm ? Date.parse(result.expiraEm) : Date.now() + 60 * 60 * 1000,
  };
  return correiosTokenCache.token;
}

function createCorreiosQuoteUrl(kind, serviceCode, configuration, destinationCep, weightGrams) {
  const query = new URLSearchParams({
    cepOrigem: configuration.originCep,
    cepDestino: destinationCep,
    psObjeto: String(Math.ceil(weightGrams)),
    tpObjeto: "2",
    comprimento: String(configuration.length),
    largura: String(configuration.width),
    altura: String(configuration.height),
  });
  return `https://api.correios.com.br/${kind}/v1/nacional/${encodeURIComponent(serviceCode)}?${query}`;
}

async function requestCorreios(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const route = new URL(url).pathname;
    const error = new Error(
      `A API dos Correios retornou HTTP ${response.status} em ${route}. Confira se o servico esta habilitado no contrato e se token, CEP e dimensoes estao corretos.`,
    );
    error.status = 502;
    throw error;
  }
  return result;
}

async function getCorreiosQuotes(items, destinationCep) {
  const configuration = getConfiguredCorreios();
  const token = await getCorreiosToken(configuration);
  const weight = items.reduce(
    (sum, item) => sum + configuration.itemWeight * item.quantity,
    0,
  );
  const cep = destinationCep.replace(/\D/g, "");
  const quotes = await Promise.all(
    configuration.serviceCodes.map(async (serviceCode) => {
      const [price, deadline] = await Promise.all([
        requestCorreios(
          createCorreiosQuoteUrl("preco", serviceCode, configuration, cep, weight),
          token,
        ),
        requestCorreios(
          createCorreiosQuoteUrl("prazo", serviceCode, configuration, cep, weight),
          token,
        ),
      ]);
      const amount = Number(price.pcFinal ?? price.pcBase);
      const days = Number(deadline.prazoEntrega);
      if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(days) || days < 0) {
        throw new Error("Os Correios retornaram uma cotacao incompleta.");
      }
      return {
        serviceCode,
        name: serviceCode === "03220" ? "SEDEX" : serviceCode === "03298" ? "PAC" : `Servico ${serviceCode}`,
        shippingCents: Math.round(amount * 100),
        deliveryDays: days,
      };
    }),
  );
  return quotes.sort((a, b) => a.shippingCents - b.shippingCents);
}

const findCustomer = database.prepare(
  "SELECT id, email, full_name AS fullName, phone FROM customers WHERE id = ?",
);

app.get("/api/health", (_request, response, next) => {
  let directPix = false;
  let directPixError = null;
  if (
    process.env.PIX_KEY?.trim() &&
    process.env.PIX_MERCHANT_NAME?.trim() &&
    process.env.PIX_MERCHANT_CITY?.trim()
  ) {
    try {
      validatePixKey(process.env.PIX_KEY.trim());
      normalizePixMerchantField(process.env.PIX_MERCHANT_NAME.trim(), 25, "PIX_MERCHANT_NAME");
      normalizePixMerchantField(process.env.PIX_MERCHANT_CITY.trim(), 15, "PIX_MERCHANT_CITY");
      directPix = true;
    } catch (error) {
      if (error.status !== 503) return next(error);
      directPixError = error.message;
    }
  } else {
    directPixError = "Configure PIX_KEY, PIX_MERCHANT_NAME e PIX_MERCHANT_CITY no .env.";
  }
  response.json({
    status: "ok",
    integrations: {
      directPix,
      directPixError,
      freeShipping: (process.env.SHIPPING_MODE || "free") === "free",
      correios: Boolean(
        process.env.CORREIOS_USER &&
          process.env.CORREIOS_ACCESS_CODE &&
          process.env.CORREIOS_POSTAL_CARD &&
          process.env.CORREIOS_ORIGIN_CEP &&
          process.env.CORREIOS_PACKAGE_LENGTH_CM &&
          process.env.CORREIOS_PACKAGE_WIDTH_CM &&
          process.env.CORREIOS_PACKAGE_HEIGHT_CM &&
          process.env.CORREIOS_ITEM_WEIGHT_GRAMS &&
          process.env.CORREIOS_SERVICE_CODES,
      ),
      fixedShipping: Boolean(process.env.SHIPPING_FLAT_RATE_CENTS?.trim() && process.env.SHIPPING_FLAT_RATE_DAYS?.trim()),
    },
  });
});

app.get("/api/session", (request, response) => {
  if (!request.session.csrfToken) request.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  const user = request.session.userId ? findCustomer.get(request.session.userId) : null;
  request.session.save((error) => {
    if (error) return sendError(response, 500, "Nao foi possivel iniciar a sessao.");
    response.json({ csrfToken: request.session.csrfToken, user: user || null });
  });
});

app.post("/api/auth/register", registerLimiter, requireCsrf, asyncRoute(async (request, response) => {
  const { name, email, phone, password } = request.body || {};
  if (
    typeof name !== "string" ||
    name.trim().length < 3 ||
    name.trim().length > 120 ||
    !validEmail(email) ||
    typeof phone !== "string" ||
    phone.replace(/\D/g, "").length < 10 ||
    phone.replace(/\D/g, "").length > 15 ||
    typeof password !== "string" ||
    password.length < 10 ||
    password.length > 200
  ) {
    return sendError(response, 400, "Informe nome, e-mail e telefone validos; a senha precisa ter ao menos 10 caracteres.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (database.prepare("SELECT 1 FROM customers WHERE email = ?").get(normalizedEmail)) {
    return sendError(response, 409, "Ja existe uma conta com este e-mail.");
  }
  const userId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 12);
  database.prepare(`
    INSERT INTO customers (id, email, full_name, phone, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, normalizedEmail, name.trim(), phone.trim(), passwordHash, new Date().toISOString());
  await regenerateSession(request);
  request.session.userId = userId;
  request.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  await saveSession(request);
  response.status(201).json({ user: findCustomer.get(userId), csrfToken: request.session.csrfToken });
}));

app.post("/api/auth/login", loginLimiter, requireCsrf, asyncRoute(async (request, response) => {
  const { email, password } = request.body || {};
  if (!validEmail(email) || typeof password !== "string" || password.length > 200) {
    return sendError(response, 400, "Informe e-mail e senha validos.");
  }
  const customer = database.prepare("SELECT * FROM customers WHERE email = ?").get(email.trim().toLowerCase());
  const validPassword = customer
    ? await bcrypt.compare(password, customer.password_hash)
    : await bcrypt.compare(password, "$2b$12$C6UzMDM.H6dfI/f/IKcEe.4o9B0azt/T7YhY1Yj2Jd9h5r1pR7h2e");
  if (!customer || !validPassword) return sendError(response, 401, "E-mail ou senha incorretos.");

  await regenerateSession(request);
  request.session.userId = customer.id;
  request.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  await saveSession(request);
  response.json({ user: findCustomer.get(customer.id), csrfToken: request.session.csrfToken });
}));

app.post("/api/auth/logout", requireCsrf, (request, response, next) => {
  request.session.destroy((error) => {
    if (error) return next(error);
    response.clearCookie("geekzone.sid", { httpOnly: true, sameSite: "lax", secure: production });
    response.status(204).end();
  });
});

app.post("/api/shipping/quotes", requireCsrf, requireUser, asyncRoute(async (request, response) => {
  const { postalCode, items } = request.body || {};
  if (!/^[0-9]{5}-?[0-9]{3}$/.test(postalCode || "")) {
    return sendError(response, 400, "Informe um CEP brasileiro valido.");
  }
  let normalized;
  try {
    normalized = normalizeItems(items);
  } catch (error) {
    return sendError(response, 400, error.message);
  }
  const shippingMode = process.env.SHIPPING_MODE || "free";
  let quotes;
  if (shippingMode === "free") {
    quotes = [getFreeShippingQuote()];
  } else if (shippingMode === "fixed") {
    quotes = [getFixedShippingQuote()];
  } else if (shippingMode === "correios") {
    quotes = await getCorreiosQuotes(normalized, postalCode);
  } else {
    const error = new Error("SHIPPING_MODE invalido. Use free, fixed ou correios.");
    error.status = 503;
    throw error;
  }
  request.session.shippingQuote = {
    postalCode: postalCode.replace(/\D/g, ""),
    items: normalized.map(({ product, quantity }) => ({ id: product.id, quantity })),
    quotes,
    createdAt: Date.now(),
  };
  await saveSession(request);
  response.json({ quotes });
}));

app.post("/api/checkout", checkoutLimiter, requireCsrf, requireUser, asyncRoute(async (request, response) => {
  const { items, address, shippingServiceCode } = request.body || {};
  let normalized;
  try {
    normalized = normalizeItems(items);
  } catch (error) {
    return sendError(response, 400, error.message);
  }
  if (!validAddress(address)) return sendError(response, 400, "Confira o endereco e o estado selecionado.");
  const shippingMode = process.env.SHIPPING_MODE || "free";
  let shipping;
  if (shippingMode === "free") {
    shipping = getFreeShippingQuote();
  } else {
    const savedQuote = request.session.shippingQuote;
    const sameItems =
      savedQuote &&
      JSON.stringify(savedQuote.items) ===
        JSON.stringify(normalized.map(({ product, quantity }) => ({ id: product.id, quantity })));
    if (
      !savedQuote ||
      Date.now() - savedQuote.createdAt > 10 * 60 * 1000 ||
      savedQuote.postalCode !== address.postalCode.replace(/\D/g, "") ||
      !sameItems
    ) {
      return sendError(response, 409, "A cotacao de frete expirou. Calcule novamente.");
    }
    shipping = savedQuote.quotes.find((quote) => quote.serviceCode === shippingServiceCode);
    if (!shipping) return sendError(response, 400, "A opcao de frete expirou. Calcule novamente.");
  }

  const user = database.prepare("SELECT * FROM customers WHERE id = ?").get(request.session.userId);
  if (!user) return sendError(response, 401, "Entre na sua conta para continuar.");
  const subtotal = normalized.reduce(
    (sum, item) => sum + item.product.priceInCents * item.quantity,
    0,
  );
  const totalCents = subtotal + shipping.shippingCents;
  const orderId = crypto.randomUUID();
  const publicCode = `GZ-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const now = new Date().toISOString();
  const pixQr = await createDirectPixQr({ totalCents, publicCode });
  const insertOrder = database.transaction(() => {
    database.prepare(`
      INSERT INTO orders (
        id, public_code, user_id, status, payment_status, payment_provider,
        payment_qr_code, payment_qr_base64, subtotal_cents, shipping_cents,
        shipping_service, shipping_days, address_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'aguardando_pagamento', 'pending', 'pix_direto', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      publicCode,
      user.id,
      pixQr.payload,
      pixQr.qrCodeBase64,
      subtotal,
      shipping.shippingCents,
      shipping.name,
      shipping.deliveryDays,
      JSON.stringify(address),
      now,
      now,
    );
    const insertItem = database.prepare(`
      INSERT INTO order_items (order_id, product_id, name, quantity, unit_price_cents)
      VALUES (?, ?, ?, ?, ?)
    `);
    normalized.forEach(({ product, quantity }) =>
      insertItem.run(orderId, product.id, product.name, quantity, product.priceInCents),
    );
  });
  insertOrder();
  delete request.session.shippingQuote;
  await saveSession(request);
  response.status(201).json({
    orderId,
    orderCode: publicCode,
    totalCents,
    qrCode: pixQr.payload,
    qrCodeBase64: pixQr.qrCodeBase64,
    manualConfirmation: true,
  });
}));

app.get("/api/orders", requireUser, (request, response) => {
  const orders = database.prepare(`
    SELECT id, public_code AS code, status, payment_status AS paymentStatus,
      payment_id AS paymentId, subtotal_cents AS subtotalCents,
      shipping_cents AS shippingCents, shipping_service AS shippingService,
      shipping_days AS shippingDays, tracking_code AS trackingCode,
      created_at AS createdAt
    FROM orders WHERE user_id = ? ORDER BY created_at DESC
  `).all(request.session.userId);
  const getItems = database.prepare(`
    SELECT product_id AS id, name, quantity, unit_price_cents AS priceInCents
    FROM order_items WHERE order_id = ?
  `);
  const getReturns = database.prepare(`
    SELECT id, reason, details, status, created_at AS createdAt
    FROM return_requests WHERE order_id = ? ORDER BY created_at DESC
  `);
  response.json({
    orders: orders.map((order) => ({
      ...order,
      items: getItems.all(order.id),
      returns: getReturns.all(order.id),
      address: JSON.parse(
        database.prepare("SELECT address_json FROM orders WHERE id = ?").get(order.id).address_json,
      ),
    })),
  });
});

app.post("/api/orders/:id/returns", requireCsrf, requireUser, (request, response) => {
  const order = database.prepare(`
    SELECT id, status FROM orders WHERE id = ? AND user_id = ?
  `).get(request.params.id, request.session.userId);
  if (!order) return sendError(response, 404, "Pedido nao encontrado na sua conta.");
  if (!["pago", "em_separacao", "enviado", "entregue"].includes(order.status)) {
    return sendError(response, 409, "Este pedido ainda nao pode receber solicitacao de troca/devolucao.");
  }
  const { reason, details = "" } = request.body || {};
  const allowedReasons = new Set(["arrependimento", "defeito", "produto_incorreto", "outro"]);
  if (!allowedReasons.has(reason) || typeof details !== "string" || details.length > 1000) {
    return sendError(response, 400, "Selecione um motivo valido e limite os detalhes a 1000 caracteres.");
  }
  const requestId = crypto.randomUUID();
  database.prepare(`
    INSERT INTO return_requests (id, order_id, user_id, reason, details, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'solicitada', ?)
  `).run(requestId, order.id, request.session.userId, reason, details.trim(), new Date().toISOString());
  response.status(201).json({ requestId, status: "solicitada" });
});

app.post("/api/track", requireCsrf, (request, response) => {
  const { code, email } = request.body || {};
  if (typeof code !== "string" || !validEmail(email)) {
    return sendError(response, 400, "Informe o codigo do pedido e o e-mail da compra.");
  }
  const order = database.prepare(`
    SELECT o.public_code AS code, o.status, o.payment_status AS paymentStatus,
      o.shipping_service AS shippingService, o.shipping_days AS shippingDays,
      o.tracking_code AS trackingCode, o.created_at AS createdAt
    FROM orders o JOIN customers c ON c.id = o.user_id
    WHERE o.public_code = ? AND c.email = ?
  `).get(code.trim().toUpperCase(), email.trim().toLowerCase());
  if (!order) return sendError(response, 404, "Pedido nao encontrado. Confira o codigo e o e-mail.");
  response.json({
    order: {
      ...order,
      trackingUrl: order.trackingCode
        ? `https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(order.trackingCode)}`
        : null,
    },
  });
});

app.get("/api/orders/:id/payment", requireUser, asyncRoute(async (request, response) => {
  response.set("Cache-Control", "no-store");
  const order = database.prepare(`
    SELECT public_code AS code, payment_status AS paymentStatus,
      subtotal_cents + shipping_cents AS totalCents
    FROM orders WHERE id = ? AND user_id = ?
  `).get(request.params.id, request.session.userId);
  if (!order) return sendError(response, 404, "Pedido nao encontrado na sua conta.");
  if (order.paymentStatus !== "pending") {
    return sendError(response, 409, "Este pedido nao possui um Pix pendente.");
  }
  const pixQr = await createDirectPixQr({
    totalCents: order.totalCents,
    publicCode: order.code,
  });
  database.prepare(`
    UPDATE orders SET payment_qr_code = ?, payment_qr_base64 = ?, updated_at = ? WHERE id = ?
  `).run(pixQr.payload, pixQr.qrCodeBase64, new Date().toISOString(), request.params.id);
  response.json({
    orderId: request.params.id,
    ...order,
    qrCode: pixQr.payload,
    qrCodeBase64: pixQr.qrCodeBase64,
    manualConfirmation: true,
  });
}));

app.get("/api/orders/:id/payment-status", requireUser, (request, response) => {
  response.set("Cache-Control", "no-store");
  const order = database.prepare(`
    SELECT status, payment_status AS paymentStatus FROM orders
    WHERE id = ? AND user_id = ?
  `).get(request.params.id, request.session.userId);
  if (!order) return sendError(response, 404, "Pedido nao encontrado na sua conta.");
  response.json({
    orderId: request.params.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    approved: order.paymentStatus === "approved",
  });
});

app.post("/api/admin/orders/:id/payment/confirm", requireAdmin, (request, response) => {
  const now = new Date().toISOString();
  const result = database.prepare(`
    UPDATE orders SET status = 'pago', payment_status = 'approved',
      payment_confirmed_at = ?, updated_at = ?
    WHERE id = ? AND payment_provider = 'pix_direto' AND payment_status = 'pending'
  `).run(now, now, request.params.id);
  if (result.changes === 0) {
    const order = database.prepare(`
      SELECT payment_provider AS paymentProvider, payment_status AS paymentStatus
      FROM orders WHERE id = ?
    `).get(request.params.id);
    if (!order) return sendError(response, 404, "Pedido nao encontrado.");
    return sendError(response, 409, "Pedido nao esta pendente ou nao usa Pix direto.");
  }
  response.json({ confirmed: true, paymentStatus: "approved", confirmedAt: now });
});

app.patch("/api/admin/orders/:id/shipping", requireAdmin, (request, response) => {
  const { status, trackingCode } = request.body || {};
  const allowedStatuses = new Set(["em_separacao", "enviado", "entregue"]);
  if (!allowedStatuses.has(status)) return sendError(response, 400, "Status de expedicao invalido.");
  if (
    typeof trackingCode !== "string" ||
    trackingCode.trim().length < 8 ||
    trackingCode.trim().length > 40 ||
    !/^[A-Z0-9]+$/i.test(trackingCode.trim())
  ) {
    return sendError(response, 400, "Informe um codigo de rastreio valido.");
  }
  const result = database.prepare(`
    UPDATE orders SET status = ?, tracking_code = ?, updated_at = ?
    WHERE id = ? AND payment_status = 'approved'
  `).run(status, trackingCode.trim().toUpperCase(), new Date().toISOString(), request.params.id);
  if (result.changes === 0) return sendError(response, 404, "Pedido pago nao encontrado.");
  response.json({ updated: true });
});

app.get("/", (_request, response) => response.sendFile(path.join(root, "index.html")));
app.get("/style.css", (_request, response) => response.sendFile(path.join(root, "style.css")));
app.get("/script.js", (_request, response) => response.sendFile(path.join(root, "script.js")));
app.use("/images", express.static(path.join(root, "images"), { dotfiles: "deny", index: false }));
app.get("/payment/return", (_request, response) => response.sendFile(path.join(root, "index.html")));

app.use("/api", (_request, response) => sendError(response, 404, "Servico nao encontrado."));
app.use((error, _request, response, _next) => {
  console.error("Erro na API:", error.message);
  if (response.headersSent) return;
  const status = Number.isInteger(error.status) ? error.status : 500;
  response.status(status).json({
    error:
      status >= 500 && status !== 503 && !error.expose
        ? "Nao foi possivel concluir a solicitacao. Tente novamente."
        : error.message,
  });
});

app.listen(port, () => {
  console.log(`GeekZone disponivel em http://localhost:${port}`);
});
