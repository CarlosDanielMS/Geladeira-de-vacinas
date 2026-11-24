// Copie para config.js (esta no .gitignore). Este usuario fica visivel no navegador:
// crie no broker um usuario SO do painel, com ACL: assinar sis1a/<grupo>/<local>/# e publicar apenas em .../comando.
window.CONFIG = {
  mqttUrl: "wss://SEU-CLUSTER.s1.eu.hivemq.cloud:8884/mqtt",
  mqttUser: "usuario_painel",
  mqttPass: "SENHA_DO_PAINEL",
  base: "sis1a/g01/geladeira1/",
  dispositivo: "geladeira1"
};
