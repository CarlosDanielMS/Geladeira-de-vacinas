#pragma once
// Buffer circular de leituras (guarda as mais recentes; descarta a mais antiga quando cheio).
#include <stdint.h>
#include <string.h>

struct Leitura {
  uint32_t up_s;     // segundos desde o boot (convertido para epoch no envio)
  float temp_c;      // NaN se leitura invalida
  int16_t dist_cm;
  uint8_t estado;    // enum Estado
  uint8_t porta;     // 1 = aberta
};

template <int N>
class Fila {
 public:
  uint32_t descartadas = 0;
  int tamanho() const { return n; }
  void push(const Leitura& l) {
    if (n == N) { ini = (ini + 1) % N; n--; descartadas++; }
    v[(ini + n) % N] = l; n++;
  }
  // copia ate max leituras (da mais antiga) sem remover
  int copia(Leitura* dst, int max) const {
    int k = n < max ? n : max;
    for (int i = 0; i < k; i++) dst[i] = v[(ini + i) % N];
    return k;
  }
  void remove(int k) { if (k > n) k = n; ini = (ini + k) % N; n -= k; }
 private:
  Leitura v[N]; int ini = 0, n = 0;
};
