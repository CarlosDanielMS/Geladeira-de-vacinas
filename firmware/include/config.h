#pragma once
// Configuracao NAO secreta. Segredos ficam em secrets.h (fora do Git).

// Identificacao e topicos: sis1a/<grupo>/<local>/{telemetria,estado,comando,alerta,ack}
#define GRUPO "g-carlos-7f3a"            // TROCAR pelo codigo do grupo
#define LOCAL "geladeira1"
#define TOPIC_BASE "sis1a/" GRUPO "/" LOCAL "/"

// Pinos
#define PIN_DHT    15
#define PIN_TRIG    5
#define PIN_ECHO   18
#define PIN_BUZZER  4

// Regra de seguranca (faixa 2-8 C)
#define T_ALTA        8.0f   // acima disso conta como excursao
#define T_ALTA_OK     7.0f   // histerese: alarme so desliga abaixo disso
#define T_BAIXA       2.0f
#define T_BAIXA_OK    3.0f
#define T_CRITICA    -3.0f   // abaixo disso o alarme (buzzer) dispara NA HORA, sem ATRASO_TEMP_S
#define ATRASO_TEMP_S 30     // DEMO (30 s). Producao: 300 (5 min fora da faixa -> alarme)
#define PORTA_ABRE_CM 20.0f  // distancia > 20 cm = porta aberta
#define PORTA_FECHA_CM 15.0f // histerese: < 15 cm = porta fechada
#define ATRASO_PORTA_S 180   // porta aberta 3 min -> alarme
#define FALHAS_MAX     3     // leituras NaN seguidas -> estado seguro (alarme)

// Tempos
#define LEITURA_MS       2000UL     // DHT22 aguenta ~2 s
#define TELEMETRIA_MS   10000UL     // publicacao MQTT
#define ESTADO_MS       30000UL     // republica estado (retido)
#define REGISTRO_S         60       // 1 leitura/min vai para o buffer/D1
#define COOLDOWN_ALERTA_MS 300000UL // 5 min
#define LOTE_MAX           30       // leituras por POST HTTP
#define BUFFER_CAP       1440       // 24 h a 1 leitura/min

// Comando
#define SILENCIO_MAX_MIN 30
