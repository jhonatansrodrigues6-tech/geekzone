const root = document.documentElement;
const themeToggle = document.querySelector("#theme-toggle");
const themeIcon = document.querySelector("#theme-icon");
const cartCount = document.querySelector("#cart-count");
const cartTotal = document.querySelector("#cart-total");
const openCartButton = document.querySelector("#open-cart");
const checkoutDialog = document.querySelector("#checkout-dialog");
const accountDialog = document.querySelector("#account-dialog");
const trackingDialog = document.querySelector("#tracking-dialog");
const cartStage = document.querySelector("#cart-stage");
const detailsStage = document.querySelector("#details-stage");
const pixStage = document.querySelector("#pix-stage");
const dialogTitle = document.querySelector("#dialog-title");
const cartLines = document.querySelector("#cart-lines");
const emptyCart = document.querySelector("#empty-cart");
const cartSubtotal = document.querySelector("#cart-subtotal");
const cartGrandTotal = document.querySelector("#cart-grand-total");
const checkoutTotal = document.querySelector("#checkout-total");
const startCheckoutButton = document.querySelector("#start-checkout");
const checkoutForm = document.querySelector("#checkout-form");
const payOrderButton = document.querySelector("#pay-order");
const checkoutFeedback = document.querySelector("#checkout-feedback");
const pixQrImage = document.querySelector("#pix-qr-image");
const pixCopyCode = document.querySelector("#pix-copy-code");
const pixPaymentFeedback = document.querySelector("#pix-payment-feedback");
const verifyPixPaymentButton = document.querySelector("#verify-pix-payment");
const accountAuth = document.querySelector("#account-auth");
const accountProfile = document.querySelector("#account-profile");
const returnRequestStage = document.querySelector("#return-request-stage");
const accountWelcome = document.querySelector("#account-welcome");
const accountFeedback = document.querySelector("#account-feedback");
const accountOrders = document.querySelector("#account-orders");
const accountOrdersMessage = document.querySelector("#account-orders-message");
const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");
const returnForm = document.querySelector("#return-form");
const trackingForm = document.querySelector("#tracking-form");
const trackingResult = document.querySelector("#tracking-result");
const toast = document.querySelector("#toast");
const voiceAssistantPanel = document.querySelector("#voice-assistant-panel");
const voiceAssistantLauncher = document.querySelector("#voice-assistant-launcher");
const voiceAssistantClose = document.querySelector("#voice-assistant-close");
const voiceAssistantStatus = document.querySelector("#voice-assistant-status");
const voiceAssistantTranscript = document.querySelector("#voice-assistant-transcript");
const voiceAssistantMic = document.querySelector("#voice-assistant-mic");
const voiceAssistantMicLabel = document.querySelector("#voice-assistant-mic-label");
const voiceAssistantCommandForm = document.querySelector("#voice-assistant-command-form");
const voiceAssistantCommandInput = document.querySelector("#voice-assistant-command-input");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#product-search");
const productCards = [...document.querySelectorAll(".product-card")];
const productButtons = [...document.querySelectorAll(".buy-button")];
const noResults = document.querySelector("#no-results");
const categoryButtons = [...document.querySelectorAll(".category-button")];
const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const cartStorageKey = "geekzone-cart";
const catalog = new Map(
  productButtons.map((button) => [
    button.dataset.name,
    {
      id: button.dataset.name,
      name: button.dataset.name,
      priceInCents: Math.round(Number(button.dataset.price) * 100),
      image: button.closest(".product-card").querySelector(".product-photo").src,
      imageAlt: button.closest(".product-card").querySelector(".product-photo").alt,
    },
  ]),
);
const cart = new Map();
let currentUser = null;
let csrfToken = "";
let toastTimeout;
let selectedCategory = "all";
let checkoutPending = false;
let ordersCache = [];
let activePixOrderId = null;
let pixPollingTimer = 0;
let pixStatusChecking = false;
let voiceRecognition = null;
let voiceListening = false;

function formatPrice(cents) {
  return currency.format(cents / 100);
}

function getCartTotals() {
  let count = 0;
  let subtotalCents = 0;

  cart.forEach((quantity, id) => {
    const product = catalog.get(id);
    if (!product) return;
    count += quantity;
    subtotalCents += product.priceInCents * quantity;
  });
  return { count, subtotalCents };
}

function saveCart() {
  try {
    localStorage.setItem(
      cartStorageKey,
      JSON.stringify([...cart].map(([id, quantity]) => ({ id, quantity }))),
    );
  } catch (error) {
    console.warn("Nao foi possivel salvar o carrinho neste navegador.", error);
  }
}

function loadCart() {
  try {
    const savedCart = localStorage.getItem(cartStorageKey);
    if (!savedCart) return;
    const entries = JSON.parse(savedCart);
    if (!Array.isArray(entries)) throw new TypeError("Carrinho salvo invalido.");
    entries.forEach((entry) => {
      if (
        entry &&
        catalog.has(entry.id) &&
        Number.isSafeInteger(entry.quantity) &&
        entry.quantity > 0 &&
        entry.quantity <= 20
      ) {
        cart.set(entry.id, entry.quantity);
      }
    });
  } catch (error) {
    console.warn("Nao foi possivel recuperar o carrinho salvo.", error);
  }
}

async function apiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD"].includes((options.method || "GET").toUpperCase()) && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  let response;
  try {
    response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  } catch {
    throw new Error("Nao foi possivel conectar a loja. Inicie o servidor com npm start.");
  }
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Nao foi possivel concluir a solicitacao.");
  return result;
}

function setTheme(theme) {
  root.dataset.theme = theme;
  const dark = theme === "dark";
  themeIcon.textContent = dark ? "☀️" : "🌙";
  themeToggle.setAttribute("aria-label", dark ? "Ativar modo claro" : "Ativar modo escuro");
  try {
    localStorage.setItem("geekzone-theme", theme);
  } catch (error) {
    console.warn("Nao foi possivel salvar a preferencia de tema.", error);
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function normalizeVoiceText(value) {
  return value
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function speakAssistant(message) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = "pt-BR";
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

function respondToVoiceAssistant(message, shouldSpeak = true) {
  voiceAssistantStatus.textContent = message;
  if (shouldSpeak) speakAssistant(message);
}

function selectVoiceCategory(filter) {
  const button = categoryButtons.find((categoryButton) => categoryButton.dataset.filter === filter);
  if (!button) return false;
  selectedCategory = filter;
  categoryButtons.forEach((categoryButton) => {
    const active = categoryButton === button;
    categoryButton.classList.toggle("is-active", active);
    categoryButton.setAttribute("aria-pressed", String(active));
  });
  filterProducts();
  return true;
}

function handleVoiceCommand(transcript) {
  const command = normalizeVoiceText(transcript);
  voiceAssistantTranscript.textContent = `Você disse: “${transcript}”`;
  if (!command) {
    respondToVoiceAssistant("Não consegui entender. Tente falar novamente.");
    return;
  }

  if (/\b(modo escuro|tema escuro|escurecer|dark mode)\b/.test(command)) {
    setTheme("dark");
    respondToVoiceAssistant("Modo escuro ativado.");
    return;
  }
  if (/\b(modo claro|tema claro|clarear|light mode)\b/.test(command)) {
    setTheme("light");
    respondToVoiceAssistant("Modo claro ativado.");
    return;
  }
  if (/\b(alternar tema|trocar tema|mudar tema)\b/.test(command)) {
    const theme = root.dataset.theme === "dark" ? "light" : "dark";
    setTheme(theme);
    respondToVoiceAssistant(`Modo ${theme === "dark" ? "escuro" : "claro"} ativado.`);
    return;
  }
  if (/\b(ajuda|o que voce faz|comandos)\b/.test(command)) {
    respondToVoiceAssistant(
      "Posso adicionar um boneco ao carrinho, abrir o carrinho, filtrar a coleção ou mudar o tema. Por exemplo, diga comprar Virginia Fonseca ou modo escuro.",
    );
    return;
  }
  if (/\b(abrir|mostrar|ver)\s+(meu\s+)?carrinho\b/.test(command)) {
    openCartButton.click();
    respondToVoiceAssistant("Abri seu carrinho. Você pode revisar os itens e continuar para o checkout.");
    return;
  }
  if (/\b(finalizar compra|ir para o checkout|continuar para o pagamento)\b/.test(command)) {
    if (cart.size === 0) {
      respondToVoiceAssistant("Seu carrinho está vazio. Peça para adicionar um produto primeiro.");
      return;
    }
    startCheckoutButton.click();
    respondToVoiceAssistant("Vamos continuar. Confira os dados do pedido na tela.");
    return;
  }

  const categoryCommands = [
    { filter: "influenciadores", pattern: /\b(influenciadores|influenciadoras)\b/ },
    { filter: "atores", pattern: /\b(atores|atrizes)\b/ },
    { filter: "cantores", pattern: /\b(cantores|cantoras)\b/ },
    { filter: "novidades", pattern: /\b(novidades|lancamentos)\b/ },
  ];
  const categoryCommand = categoryCommands.find(({ pattern }) => pattern.test(command));
  if (/\b(categoria|colecao|produtos|catalogo|mostrar|filtrar)\b/.test(command) && categoryCommand) {
    selectVoiceCategory(categoryCommand.filter);
    document.querySelector("#catalog-title").scrollIntoView({ behavior: "smooth" });
    respondToVoiceAssistant(`Mostrando a categoria ${categoryCommand.filter}.`);
    return;
  }
  if (/\b(ver colecao|mostrar produtos|abrir catalogo|ver catalogo)\b/.test(command)) {
    searchInput.value = "";
    selectVoiceCategory("all");
    document.querySelector("#catalog-title").scrollIntoView({ behavior: "smooth" });
    respondToVoiceAssistant("Mostrando todos os produtos da coleção.");
    return;
  }

  const wantsToBuy = /\b(comprar|adicionar|adiciona|colocar|quero)\b/.test(command);
  if (wantsToBuy) {
    const match = [...productButtons]
      .map((button) => {
        const name = normalizeVoiceText(button.dataset.name);
        const shortName = name.replace(/\s+\d+$/, "").trim();
        return { button, candidates: [...new Set([name, shortName])] };
      })
      .map(({ button, candidates }) => ({
        button,
        matchedName: candidates.find((name) => name && command.includes(name)),
      }))
      .filter(({ matchedName }) => matchedName)
      .sort((first, second) => second.matchedName.length - first.matchedName.length)[0];
    if (match) {
      match.button.click();
      respondToVoiceAssistant(`${match.button.dataset.name} foi adicionado ao carrinho.`);
      return;
    }
    respondToVoiceAssistant("Não identifiquei o produto. Diga o nome como aparece na vitrine, por exemplo comprar Virginia Fonseca.");
    return;
  }

  const searchQuery = command.replace(/^(buscar|pesquisar|procura(r)?|quero ver)\s+/, "").trim();
  if (searchQuery && searchQuery !== command) {
    searchInput.value = searchQuery;
    selectVoiceCategory("all");
    filterProducts();
    document.querySelector("#catalog-title").scrollIntoView({ behavior: "smooth" });
    respondToVoiceAssistant(`Pesquisei por ${searchQuery}.`);
    return;
  }

  respondToVoiceAssistant("Ainda não entendi esse pedido. Diga ajuda para ouvir exemplos de comandos.");
}

function setVoiceListening(isListening) {
  voiceListening = isListening;
  voiceAssistantMic.setAttribute("aria-pressed", String(isListening));
  voiceAssistantMicLabel.textContent = isListening ? "Parar de ouvir" : "Começar a falar";
}

function stopVoiceListening() {
  if (voiceRecognition && voiceListening) voiceRecognition.stop();
}

function initializeVoiceAssistant() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    voiceAssistantMic.disabled = true;
    voiceAssistantMicLabel.textContent = "Voz não suportada";
    voiceAssistantStatus.textContent =
      "O reconhecimento de voz não está disponível neste navegador. Tente usar uma versão recente do Chrome ou Edge.";
    return;
  }

  voiceRecognition = new Recognition();
  voiceRecognition.lang = "pt-BR";
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = false;
  voiceRecognition.maxAlternatives = 1;
  voiceRecognition.onstart = () => {
    setVoiceListening(true);
    respondToVoiceAssistant("Estou ouvindo. Diga um comando quando quiser.", false);
  };
  voiceRecognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript;
    if (transcript) handleVoiceCommand(transcript);
    else respondToVoiceAssistant("Não consegui entender. Tente falar novamente.");
  };
  voiceRecognition.onerror = (event) => {
    const messages = {
      "not-allowed": "O acesso ao microfone foi bloqueado. Permita o uso do microfone nas configurações do navegador.",
      "service-not-allowed": "O navegador não permitiu iniciar o reconhecimento de voz.",
      "no-speech": "Não detectei fala. Toque no microfone e tente novamente.",
      "audio-capture": "Não encontrei um microfone disponível neste dispositivo.",
      network: "O serviço de reconhecimento de voz está indisponível no momento. Use o campo de texto para enviar comandos.",
    };
    setVoiceListening(false);
    respondToVoiceAssistant(messages[event.error] || "O reconhecimento de voz falhou. Tente novamente.");
  };
  voiceRecognition.onend = () => {
    setVoiceListening(false);
  };
}

function updateFreeShippingTotal() {
  checkoutTotal.textContent = formatPrice(getCartTotals().subtotalCents);
  payOrderButton.disabled = getCartTotals().count === 0;
}

function setCheckoutFeedback(message, isError = true) {
  checkoutFeedback.textContent = message;
  checkoutFeedback.classList.toggle("is-error", isError);
}

function createCartLine(product, quantity) {
  const line = document.createElement("article");
  line.className = "cart-line";
  line.dataset.productId = product.id;

  const image = document.createElement("img");
  image.className = "cart-line-image";
  image.src = product.image;
  image.alt = product.imageAlt;

  const info = document.createElement("div");
  info.className = "cart-line-info";
  const name = document.createElement("h3");
  name.textContent = product.name;
  const unitPrice = document.createElement("div");
  unitPrice.className = "cart-line-price";
  unitPrice.textContent = `${formatPrice(product.priceInCents)} cada`;
  const subtotal = document.createElement("div");
  subtotal.className = "cart-line-subtotal";
  subtotal.textContent = formatPrice(product.priceInCents * quantity);
  info.append(name, unitPrice, subtotal);

  const actions = document.createElement("div");
  actions.className = "cart-line-actions";
  const quantityControl = document.createElement("div");
  quantityControl.className = "quantity-control";
  quantityControl.setAttribute("aria-label", `Quantidade de ${product.name}`);

  const decrease = document.createElement("button");
  decrease.className = "quantity-button";
  decrease.type = "button";
  decrease.dataset.action = "decrease";
  decrease.setAttribute("aria-label", `Diminuir quantidade de ${product.name}`);
  decrease.textContent = "−";

  const quantityText = document.createElement("span");
  quantityText.className = "quantity-value";
  quantityText.textContent = String(quantity);
  quantityText.setAttribute("aria-live", "polite");

  const increase = document.createElement("button");
  increase.className = "quantity-button";
  increase.type = "button";
  increase.dataset.action = "increase";
  increase.setAttribute("aria-label", `Aumentar quantidade de ${product.name}`);
  increase.textContent = "+";
  quantityControl.append(decrease, quantityText, increase);

  const remove = document.createElement("button");
  remove.className = "remove-item";
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.setAttribute("aria-label", `Remover ${product.name} do carrinho`);
  remove.textContent = "Remover";
  actions.append(quantityControl, remove);
  line.append(image, info, actions);
  return line;
}

function renderCart() {
  const { count, subtotalCents } = getCartTotals();
  const hasItems = count > 0;
  cartCount.textContent = `${count} ${count === 1 ? "item" : "itens"}`;
  cartTotal.textContent = formatPrice(subtotalCents);
  openCartButton.setAttribute(
    "aria-label",
    `Abrir carrinho: ${count} ${count === 1 ? "item" : "itens"}, total ${formatPrice(subtotalCents)}`,
  );
  cartSubtotal.textContent = formatPrice(subtotalCents);
  cartGrandTotal.textContent = formatPrice(subtotalCents);
  checkoutTotal.textContent = formatPrice(subtotalCents);
  payOrderButton.disabled = !hasItems;
  emptyCart.hidden = hasItems;
  startCheckoutButton.hidden = !hasItems;
  cartLines.hidden = !hasItems;
  cartLines.replaceChildren();
  cart.forEach((quantity, id) => {
    const product = catalog.get(id);
    if (product) cartLines.append(createCartLine(product, quantity));
  });
}

function showCheckoutStage(stage) {
  if (stage !== "pix") window.clearInterval(pixPollingTimer);
  cartStage.hidden = stage !== "cart";
  detailsStage.hidden = stage !== "details";
  pixStage.hidden = stage !== "pix";
  dialogTitle.textContent =
    stage === "details" ? "Finalizar pedido" : stage === "pix" ? "Pagamento Pix" : "Seu carrinho";
}

function showPixPayment(payment) {
  if (
    typeof payment.qrCode !== "string" ||
    typeof payment.qrCodeBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payment.qrCodeBase64)
  ) {
    throw new Error("A loja nao retornou um QR Code Pix valido.");
  }
  activePixOrderId = payment.orderId;
  pixStatusChecking = false;
  pixQrImage.src = `data:image/png;base64,${payment.qrCodeBase64}`;
  pixQrImage.hidden = false;
  pixCopyCode.value = payment.qrCode;
  pixCopyCode.disabled = false;
  document.querySelector("#pix-order-code").textContent =
    `Pedido ${payment.orderCode || payment.code} · Total ${formatPrice(payment.totalCents)}`;
  verifyPixPaymentButton.disabled = false;
  pixPaymentFeedback.textContent =
    "O Pix será confirmado pela loja após a conferência do crédito na conta. A confirmação não é automática.";
  pixPaymentFeedback.classList.remove("is-error");
  showCheckoutStage("pix");
  if (!checkoutDialog.open) checkoutDialog.showModal();
  window.clearInterval(pixPollingTimer);
  pixPollingTimer = window.setInterval(checkPixPaymentStatus, 8000);
}

async function checkPixPaymentStatus() {
  if (!activePixOrderId || pixStatusChecking) return;
  pixStatusChecking = true;
  try {
    const result = await apiRequest(
      `/api/orders/${encodeURIComponent(activePixOrderId)}/payment-status`,
    );
    if (result.approved) {
      window.clearInterval(pixPollingTimer);
      pixQrImage.hidden = true;
      pixCopyCode.disabled = true;
      verifyPixPaymentButton.disabled = true;
      pixPaymentFeedback.textContent = "Pagamento Pix confirmado pela loja. Obrigado pela compra!";
      await loadOrders();
      return;
    }
    if (["rejected", "cancelled"].includes(result.paymentStatus)) {
      window.clearInterval(pixPollingTimer);
      pixQrImage.hidden = true;
      pixCopyCode.disabled = true;
      verifyPixPaymentButton.disabled = true;
    }
    pixPaymentFeedback.textContent =
      result.paymentStatus === "pending"
        ? "Pedido aguardando pagamento. Após pagar, a loja confirmará o crédito manualmente."
        : `Status do pagamento: ${statusLabel(result.status)}.`;
    pixPaymentFeedback.classList.remove("is-error");
  } catch (error) {
    pixPaymentFeedback.textContent = error.message;
    pixPaymentFeedback.classList.add("is-error");
  } finally {
    pixStatusChecking = false;
  }
}

function setAccountView(view) {
  accountAuth.hidden = view !== "auth";
  accountProfile.hidden = view !== "profile";
  returnRequestStage.hidden = view !== "return";
}

function setAuthMode(mode) {
  const login = mode === "login";
  loginForm.hidden = !login;
  registerForm.hidden = login;
  document.querySelector("#login-tab").classList.toggle("is-active", login);
  document.querySelector("#register-tab").classList.toggle("is-active", !login);
  document.querySelector("#login-tab").setAttribute("aria-selected", String(login));
  document.querySelector("#register-tab").setAttribute("aria-selected", String(!login));
  accountFeedback.textContent = "";
}

function renderAccount() {
  setAccountView(currentUser ? "profile" : "auth");
  if (!currentUser) {
    document.querySelector("#account-title").textContent = "Minha conta";
    return;
  }
  document.querySelector("#account-title").textContent = "Minha conta";
  accountWelcome.textContent = `Ola, ${currentUser.fullName}.`;
  accountFeedback.textContent = "";
}

function statusLabel(status) {
  const labels = {
    aguardando_pagamento: "Aguardando pagamento",
    falha_no_checkout: "Falha ao criar pagamento",
    pago: "Pagamento aprovado",
    em_separacao: "Em separação",
    enviado: "Enviado",
    entregue: "Entregue",
    pagamento_recusado: "Pagamento recusado",
    pagamento_cancelado: "Pagamento cancelado",
    reembolsado: "Reembolsado",
    contestado: "Pagamento contestado",
  };
  return labels[status] || status;
}

function renderOrders(orders) {
  ordersCache = orders;
  accountOrders.replaceChildren();
  if (!orders.length) {
    accountOrdersMessage.textContent = "Ainda nao ha pedidos nesta conta.";
    return;
  }
  accountOrdersMessage.textContent = "";

  orders.forEach((order) => {
    const card = document.createElement("article");
    card.className = "account-order";
    const heading = document.createElement("div");
    heading.className = "account-order-heading";
    const code = document.createElement("strong");
    code.textContent = order.code;
    const status = document.createElement("span");
    status.className = `order-status status-${order.status}`;
    status.textContent = statusLabel(order.status);
    heading.append(code, status);

    const itemList = document.createElement("p");
    itemList.textContent = order.items
      .map((item) => `${item.quantity}× ${item.name}`)
      .join(", ");
    const total = document.createElement("p");
    total.className = "account-order-total";
    total.textContent = `Total: ${formatPrice(order.subtotalCents + order.shippingCents)} · ${order.shippingService}`;
    card.append(heading, itemList, total);

    if (order.status === "aguardando_pagamento" && order.paymentStatus === "pending") {
      const pixButton = document.createElement("button");
      pixButton.className = "remove-item";
      pixButton.type = "button";
      pixButton.dataset.pixOrder = order.id;
      pixButton.textContent = "Ver QR Code Pix";
      card.append(pixButton);
    }

    if (order.trackingCode) {
      const tracking = document.createElement("a");
      tracking.className = "order-tracking-link";
      tracking.href = `https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(order.trackingCode)}`;
      tracking.target = "_blank";
      tracking.rel = "noopener noreferrer";
      tracking.textContent = `Rastrear objeto ${order.trackingCode}`;
      card.append(tracking);
    } else if (["pago", "em_separacao"].includes(order.status)) {
      const waiting = document.createElement("p");
      waiting.className = "order-waiting";
      waiting.textContent = "O codigo de rastreio sera exibido aqui quando o pedido for despachado.";
      card.append(waiting);
    }

    if (["pago", "em_separacao", "enviado", "entregue"].includes(order.status)) {
      const returnButton = document.createElement("button");
      returnButton.className = "remove-item";
      returnButton.type = "button";
      returnButton.dataset.returnOrder = order.id;
      returnButton.textContent = "Solicitar troca/devolucao";
      card.append(returnButton);
    }
    order.returns.forEach((returnRequest) => {
      const returnStatus = document.createElement("p");
      returnStatus.className = "order-waiting";
      returnStatus.textContent = `Solicitacao de troca/devolucao: ${returnRequest.status}`;
      card.append(returnStatus);
    });
    accountOrders.append(card);
  });
}

async function loadOrders() {
  accountOrdersMessage.textContent = "Carregando pedidos...";
  try {
    const result = await apiRequest("/api/orders");
    renderOrders(result.orders);
  } catch (error) {
    accountOrdersMessage.textContent = error.message;
  }
}

function filterProducts() {
  const query = searchInput.value.trim().toLocaleLowerCase("pt-BR");
  let visibleCount = 0;
  productCards.forEach((card) => {
    const categoryMatches =
      selectedCategory === "all" ||
      (selectedCategory === "novidades"
        ? card.dataset.new === "true"
        : card.dataset.category === selectedCategory);
    const textMatches = card.textContent.toLocaleLowerCase("pt-BR").includes(query);
    card.hidden = !(categoryMatches && textMatches);
    if (!card.hidden) visibleCount += 1;
  });
  noResults.hidden = visibleCount > 0;
}

function getCheckoutPayload() {
  const formData = new FormData(checkoutForm);
  return {
    name: String(formData.get("name")).trim(),
    email: String(formData.get("email")).trim(),
    phone: String(formData.get("phone")).trim(),
    postalCode: String(formData.get("postalCode")).trim(),
    street: String(formData.get("street")).trim(),
    number: String(formData.get("number")).trim(),
    complement: String(formData.get("complement") || "").trim(),
    district: String(formData.get("district")).trim(),
    city: String(formData.get("city")).trim(),
    state: String(formData.get("state")),
  };
}

function setUser(user) {
  currentUser = user;
  document.querySelector("#open-account").setAttribute(
    "aria-label",
    currentUser ? `Minha conta: ${currentUser.fullName}` : "Entrar ou acessar minha conta",
  );
  if (currentUser) {
    checkoutForm.elements.name.value = currentUser.fullName;
    checkoutForm.elements.email.value = currentUser.email;
    checkoutForm.elements.phone.value = currentUser.phone;
  }
  renderAccount();
}

async function startCheckout() {
  if (cart.size === 0) return;
  if (!currentUser) {
    checkoutPending = true;
    checkoutDialog.close();
    setAuthMode("login");
    renderAccount();
    accountDialog.showModal();
    accountFeedback.textContent = "Entre ou crie sua conta para continuar a compra.";
    return;
  }
  updateFreeShippingTotal();
  setCheckoutFeedback("");
  showCheckoutStage("details");
}

async function initializeSession() {
  try {
    const result = await apiRequest("/api/session");
    csrfToken = result.csrfToken;
    setUser(result.user);
  } catch (error) {
    showToast(error.message);
  }
}

let initialTheme = "light";
try {
  initialTheme =
    localStorage.getItem("geekzone-theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
} catch (error) {
  console.warn("Nao foi possivel recuperar a preferencia de tema.", error);
}
setTheme(initialTheme);
loadCart();
renderCart();

themeToggle.addEventListener("click", () => {
  setTheme(root.dataset.theme === "dark" ? "light" : "dark");
});

initializeVoiceAssistant();
voiceAssistantLauncher.addEventListener("click", () => {
  const shouldOpen = voiceAssistantPanel.hidden;
  voiceAssistantPanel.hidden = !shouldOpen;
  voiceAssistantLauncher.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen && voiceRecognition) voiceAssistantMic.focus();
  if (!shouldOpen) stopVoiceListening();
});
voiceAssistantClose.addEventListener("click", () => {
  stopVoiceListening();
  voiceAssistantPanel.hidden = true;
  voiceAssistantLauncher.setAttribute("aria-expanded", "false");
  voiceAssistantLauncher.focus();
});
voiceAssistantMic.addEventListener("click", () => {
  if (!voiceRecognition) return;
  if (voiceListening) {
    stopVoiceListening();
    respondToVoiceAssistant("Parei de ouvir.", false);
    return;
  }
  voiceAssistantTranscript.textContent = "";
  try {
    voiceRecognition.start();
  } catch (error) {
    respondToVoiceAssistant(
      error.name === "InvalidStateError"
        ? "O microfone já está iniciando. Aguarde um instante."
        : "Não foi possível iniciar o microfone. Confira a permissão do navegador e tente novamente.",
    );
  }
});
voiceAssistantCommandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = voiceAssistantCommandInput.value.trim();
  if (!command) {
    respondToVoiceAssistant("Digite um comando ou toque no microfone para falar.");
    voiceAssistantCommandInput.focus();
    return;
  }
  voiceAssistantCommandInput.value = "";
  handleVoiceCommand(command);
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  filterProducts();
});
searchInput.addEventListener("input", filterProducts);

categoryButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedCategory = button.dataset.filter;
    categoryButtons.forEach((categoryButton) => {
      const active = categoryButton === button;
      categoryButton.classList.toggle("is-active", active);
      categoryButton.setAttribute("aria-pressed", String(active));
    });
    filterProducts();
  });
});
categoryButtons[0].setAttribute("aria-pressed", "true");

productButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.name;
    cart.set(id, (cart.get(id) || 0) + 1);
    saveCart();
    renderCart();
    updateFreeShippingTotal();
    showToast(`${id} adicionado ao carrinho`);
  });
});

openCartButton.addEventListener("click", () => {
  showCheckoutStage("cart");
  renderCart();
  openCartButton.setAttribute("aria-expanded", "true");
  checkoutDialog.showModal();
});
checkoutDialog.addEventListener("close", () => {
  openCartButton.setAttribute("aria-expanded", "false");
  window.clearInterval(pixPollingTimer);
});
document.querySelector("#close-dialog").addEventListener("click", () => checkoutDialog.close());
document.querySelector("#continue-shopping").addEventListener("click", () => checkoutDialog.close());
document.querySelector("#back-to-cart").addEventListener("click", () => showCheckoutStage("cart"));
document.querySelector("#back-to-details").addEventListener("click", () => showCheckoutStage("details"));
startCheckoutButton.addEventListener("click", startCheckout);

document.querySelector("#copy-pix-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(pixCopyCode.value);
    pixPaymentFeedback.textContent = "Código Pix copiado. Cole no aplicativo do seu banco.";
    pixPaymentFeedback.classList.remove("is-error");
  } catch {
    pixCopyCode.focus();
    pixCopyCode.select();
    const copied = document.execCommand("copy");
    pixPaymentFeedback.textContent = copied
      ? "Código Pix copiado. Cole no aplicativo do seu banco."
      : "Não foi possível copiar automaticamente. Selecione e copie o código Pix.";
    pixPaymentFeedback.classList.toggle("is-error", !copied);
  }
});
verifyPixPaymentButton.addEventListener("click", checkPixPaymentStatus);

cartLines.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.closest(".cart-line").dataset.productId;
  const quantity = cart.get(id);
  if (!quantity) return;
  if (button.dataset.action === "remove" || (button.dataset.action === "decrease" && quantity === 1)) {
    cart.delete(id);
  } else if (button.dataset.action === "decrease") {
    cart.set(id, quantity - 1);
  } else if (button.dataset.action === "increase" && quantity < 20) {
    cart.set(id, quantity + 1);
  } else if (button.dataset.action === "increase") {
    showToast("O limite por produto e de 20 unidades.");
    return;
  }
  saveCart();
  renderCart();
  updateFreeShippingTotal();
});

document.querySelector("#open-account").addEventListener("click", async () => {
  renderAccount();
  accountDialog.showModal();
  if (currentUser) await loadOrders();
});
document.querySelector("#close-account").addEventListener("click", () => accountDialog.close());
document.querySelector("#login-tab").addEventListener("click", () => setAuthMode("login"));
document.querySelector("#register-tab").addEventListener("click", () => setAuthMode("register"));
document.querySelector("#refresh-orders").addEventListener("click", loadOrders);

async function authenticate(form, endpoint) {
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  accountFeedback.textContent = "Aguarde...";
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await apiRequest(endpoint, { method: "POST", body: JSON.stringify(values) });
    csrfToken = result.csrfToken;
    setUser(result.user);
    form.reset();
    accountDialog.close();
    if (checkoutPending) {
      checkoutPending = false;
      checkoutDialog.showModal();
      await startCheckout();
    } else {
      await loadOrders();
    }
  } catch (error) {
    accountFeedback.textContent = error.message;
    accountFeedback.classList.add("is-error");
  } finally {
    submitButton.disabled = false;
  }
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate(loginForm, "/api/auth/login");
});
registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate(registerForm, "/api/auth/register");
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await apiRequest("/api/auth/logout", { method: "POST", body: "{}" });
    csrfToken = "";
    setUser(null);
    ordersCache = [];
    accountDialog.close();
    await initializeSession();
    showToast("Voce saiu da sua conta.");
  } catch (error) {
    accountOrdersMessage.textContent = error.message;
  }
});

function openTrackingDialog() {
  trackingForm.reset();
  trackingResult.hidden = true;
  trackingResult.replaceChildren();
  trackingDialog.showModal();
}

document.querySelector("#open-tracking").addEventListener("click", openTrackingDialog);
document.querySelector("#close-tracking").addEventListener("click", () => trackingDialog.close());
document.querySelector("#account-track").addEventListener("click", () => {
  accountDialog.close();
  openTrackingDialog();
});
document.querySelector("#account-returns").addEventListener("click", () => {
  accountOrders.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("Escolha um pedido pago para solicitar troca ou devolucao.");
});

document.querySelector("#open-returns").addEventListener("click", async () => {
  if (!currentUser) {
    checkoutPending = false;
    renderAccount();
    setAuthMode("login");
    accountDialog.showModal();
    accountFeedback.textContent = "Entre na sua conta para consultar pedidos e solicitar troca/devolucao.";
    return;
  }
  renderAccount();
  accountDialog.showModal();
  await loadOrders();
});

accountOrders.addEventListener("click", async (event) => {
  const pixButton = event.target.closest("button[data-pix-order]");
  if (pixButton) {
    try {
      const payment = await apiRequest(
        `/api/orders/${encodeURIComponent(pixButton.dataset.pixOrder)}/payment`,
      );
      accountDialog.close();
      showPixPayment(payment);
    } catch (error) {
      accountOrdersMessage.textContent = error.message;
    }
    return;
  }
  const button = event.target.closest("button[data-return-order]");
  if (!button) return;
  document.querySelector("#return-order-id").value = button.dataset.returnOrder;
  returnForm.reset();
  document.querySelector("#return-order-id").value = button.dataset.returnOrder;
  setAccountView("return");
});

document.querySelector("#return-back").addEventListener("click", () => {
  setAccountView("profile");
  loadOrders();
});

returnForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(returnForm);
  const orderId = String(formData.get("orderId"));
  try {
    await apiRequest(`/api/orders/${encodeURIComponent(orderId)}/returns`, {
      method: "POST",
      body: JSON.stringify({
        reason: formData.get("reason"),
        details: formData.get("details"),
      }),
    });
    setAccountView("profile");
    await loadOrders();
    showToast("Solicitacao enviada para analise.");
  } catch (error) {
    accountOrdersMessage.textContent = error.message;
    setAccountView("profile");
  }
});

trackingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  trackingResult.hidden = false;
  trackingResult.textContent = "Consultando pedido...";
  try {
    const values = Object.fromEntries(new FormData(trackingForm));
    const result = await apiRequest("/api/track", {
      method: "POST",
      body: JSON.stringify(values),
    });
    const order = result.order;
    trackingResult.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = `${order.code} · ${statusLabel(order.status)}`;
    const info = document.createElement("p");
    info.textContent = order.trackingCode
      ? `Codigo dos Correios: ${order.trackingCode}`
      : "O codigo de rastreio sera informado quando o pedido for despachado.";
    trackingResult.append(heading, info);
    if (order.trackingUrl) {
      const link = document.createElement("a");
      link.href = order.trackingUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Abrir rastreio nos Correios";
      trackingResult.append(link);
    }
  } catch (error) {
    trackingResult.textContent = error.message;
  }
});

checkoutForm.elements.postalCode.addEventListener("blur", async () => {
  const cep = checkoutForm.elements.postalCode.value.replace(/\D/g, "");
  if (cep.length !== 8) return;
  try {
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    if (!response.ok) throw new Error("Servico de CEP indisponivel.");
    const address = await response.json();
    if (address.erro) return;
    checkoutForm.elements.street.value ||= address.logradouro || "";
    checkoutForm.elements.district.value ||= address.bairro || "";
    checkoutForm.elements.city.value ||= address.localidade || "";
    checkoutForm.elements.state.value = address.uf || "";
  } catch (error) {
    console.warn("Nao foi possivel consultar o CEP automaticamente.", error);
  }
});

checkoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!checkoutForm.reportValidity()) return;
  if (payOrderButton.disabled) {
    setCheckoutFeedback("Adicione pelo menos um produto ao carrinho.");
    return;
  }

  payOrderButton.disabled = true;
  setCheckoutFeedback("Criando pedido e gerando QR Code Pix...");
  const data = getCheckoutPayload();
  const address = {
    name: data.name,
    phone: data.phone,
    postalCode: data.postalCode,
    street: data.street,
    number: data.number,
    complement: data.complement,
    district: data.district,
    city: data.city,
    state: data.state,
  };
  try {
    const result = await apiRequest("/api/checkout", {
      method: "POST",
      body: JSON.stringify({
        items: [...cart].map(([id, quantity]) => ({ id, quantity })),
        address,
      }),
    });
    showPixPayment(result);
  } catch (error) {
    setCheckoutFeedback(error.message);
    payOrderButton.disabled = false;
  }
});

async function handlePaymentReturn() {
  const query = new URLSearchParams(window.location.search);
  if (query.get("payment") !== "return") return;
  history.replaceState(null, "", window.location.pathname);
  if (!currentUser) {
    checkoutPending = false;
    accountDialog.showModal();
    accountFeedback.textContent = "Entre na sua conta para consultar o estado do pedido.";
    return;
  }
  accountDialog.showModal();
  await loadOrders();
  const code = query.get("external_reference");
  const returnedOrder = ordersCache.find((order) => order.code === code);
  if (returnedOrder) {
    const message = returnedOrder.paymentStatus === "approved"
      ? "Pagamento confirmado pela loja."
      : "Pedido aguardando conferência manual do Pix pela loja.";
    accountOrdersMessage.textContent = `${message} Pedido ${returnedOrder.code}: ${statusLabel(returnedOrder.status)}.`;
  }
}

initializeSession().then(handlePaymentReturn);
