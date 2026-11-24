#pragma once
// Regra de seguranca da geladeira. Sem dependencia de Arduino (facil de testar).
#include <math.h>
#include <stdint.h>
#include "config.h"

enum Estado : uint8_t { EST_INICIANDO, EST_OK, EST_TEMP_ALTA, EST_TEMP_BAIXA, EST_PORTA_ABERTA, EST_SENSOR_FALHA };

inline const char* nomeEstado(Estado e) {
  switch (e) {
    case EST_INICIANDO:     return "iniciando";
    case EST_OK:            return "ok";
    case EST_TEMP_ALTA:     return "temp_alta";
    case EST_TEMP_BAIXA:    return "temp_baixa";
    case EST_PORTA_ABERTA:  return "porta_aberta";
    default:                return "sensor_falha";
  }
}

class Regra {
 public:
  bool alarmeAlta = false, alarmeBaixa = false, alarmePorta = false, falhaSensor = false;
  bool portaAberta = false;
  Estado estado = EST_INICIANDO;

  // now_ms = millis(); temp em C (NaN se invalida); dist em cm (<=0 ou NaN se invalida)
  void atualiza(uint32_t now_ms, float temp, float dist) {
    // --- temperatura ---
    if (isnan(temp)) {
      if (++falhas >= FALHAS_MAX) falhaSensor = true;   // estado seguro: alarme
    } else {
      falhas = 0; falhaSensor = false; viuTemp = true;
      excursao(now_ms, temp > T_ALTA,  temp < T_ALTA_OK,  alarmeAlta,  tAlta);
      excursao(now_ms, temp < T_BAIXA, temp > T_BAIXA_OK, alarmeBaixa, tBaixa);
    }
    // --- porta (histerese 15/20 cm; leitura invalida mantem o ultimo valor) ---
    if (!isnan(dist) && dist > 0) {
      if (dist > PORTA_ABRE_CM) portaAberta = true;
      else if (dist < PORTA_FECHA_CM) portaAberta = false;
    }
    if (portaAberta) {
      if (tPorta == 0) tPorta = now_ms | 1;
      if ((uint32_t)(now_ms - tPorta) >= ATRASO_PORTA_S * 1000UL) alarmePorta = true;
    } else { tPorta = 0; alarmePorta = false; }

    if (falhaSensor)       estado = EST_SENSOR_FALHA;
    else if (alarmeAlta)   estado = EST_TEMP_ALTA;
    else if (alarmeBaixa)  estado = EST_TEMP_BAIXA;
    else if (alarmePorta)  estado = EST_PORTA_ABERTA;
    else                   estado = viuTemp ? EST_OK : EST_INICIANDO;
  }
  bool alarme() const { return estado != EST_OK && estado != EST_INICIANDO; }

 private:
  uint8_t falhas = 0; bool viuTemp = false;
  uint32_t tAlta = 0, tBaixa = 0, tPorta = 0;
  // fora = fora da faixa agora; dentro = voltou para a faixa com folga (histerese)
  static void excursao(uint32_t now, bool fora, bool dentro, bool& alarme, uint32_t& t0) {
    if (fora) {
      if (t0 == 0) t0 = now | 1;                         // |1 evita confundir 0 com "sem timer"
      if ((uint32_t)(now - t0) >= ATRASO_TEMP_S * 1000UL) alarme = true;
    } else {
      t0 = 0;                                            // voltou: zera o tempo
      if (dentro) alarme = false;                        // so desarma com folga (7 C / 3 C)
    }
  }
};
