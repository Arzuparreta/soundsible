# Tablas medidas

Test: 20 GTZAN; tolerancia 70 ms; media por grabación. F1 no es porcentaje de compases correctos.
Modelo 2 de BeatNet entrenado con GTZAN: su resultado no es test independiente.

| Método | Test ejecutado | F1 pulso | F1 primer tiempo | IC bootstrap 95 % del 1 | CPU s/min audio, con separación | RAM PSS árbol MiB |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| allin1-all | 20/20 | 0.740 | 0.682 | 0.494–0.851 | 177.81 | 1917 |
| allin1-fold0 | 20/20 | 0.730 | 0.667 | 0.508–0.818 | 64.09 | 1813 |
| beatnet-1-dbn | 20/20 | 0.725 | 0.527 | 0.334–0.712 | 0.23 | 425 |
| beatnet-1-pf | 20/20 | 0.672 | 0.464 | 0.324–0.592 | 4.78 | 415 |
| beatnet-2-dbn | 20/20 | 0.890 | 0.937 | 0.833–0.995 | 0.23 | 425 |
| beatnet-2-pf | 20/20 | 0.846 | 0.809 | 0.709–0.892 | 4.49 | 415 |
| beatnetplus-generic-dbn | 20/20 | 0.794 | 0.609 | 0.420–0.788 | 0.26 | 426 |
| beatnetplus-generic-pf | 20/20 | 0.779 | 0.528 | 0.378–0.673 | 4.43 | 420 |
| beatnetplus-main-dbn | 20/20 | 0.664 | 0.386 | 0.220–0.568 | 0.25 | 426 |
| beatnetplus-nonpercussive-dbn | 20/20 | 0.739 | 0.544 | 0.357–0.714 | 0.25 | 426 |
| beatthis-final0-dbn | 20/20 | 0.820 | 0.764 | 0.619–0.895 | 7.21 | 661 |
| beatthis-final0-direct | 20/20 | 0.817 | 0.725 | 0.583–0.855 | 7.24 | 617 |
| beatthis-final0-direct-common | 20/20 | 0.803 | 0.751 | 0.618–0.875 | 7.40 | — |
| beatthis-small0-dbn | 20/20 | 0.793 | 0.734 | 0.599–0.846 | 4.24 | 645 |
| beatthis-small0-direct | 20/20 | 0.814 | 0.718 | 0.594–0.833 | 4.34 | 569 |
| beatthis-small0-direct-common | 20/20 | 0.787 | 0.740 | 0.614–0.848 | 4.50 | — |
| essentia-degara | 20/20 | 0.774 | — | — | 0.09 | 180 |
| essentia-multifeature | 20/20 | 0.760 | — | — | 0.48 | 187 |
| joint | 20/20 | 0.499 | 0.000 | 0.000–0.000 | 0.19 | 103 |
| joint-dbn | 20/20 | 0.761 | 0.273 | 0.149–0.421 | 0.72 | 101 |
| librosa-global | 20/20 | 0.733 | — | — | 0.05 | 299 |
| librosa-local | 20/20 | 0.678 | — | — | 0.05 | 309 |
| madmom-modern-default | 20/20 | 0.814 | 0.658 | 0.501–0.802 | 6.31 | 262 |
| madmom-modern-extended | 20/20 | 0.811 | 0.660 | 0.517–0.790 | 5.74 | 263 |
| madmom-original-default | 20/20 | 0.814 | 0.658 | 0.501–0.802 | 5.02 | 264 |
| madmom-original-extended | 20/20 | 0.811 | 0.660 | 0.517–0.790 | 5.50 | 250 |
| soundsible-main | 20/20 | 0.658 | 0.315 | 0.136–0.523 | 0.09 | 55 |
| soundsible-p12 | 20/20 | 0.476 | 0.000 | 0.000–0.000 | 0.13 | 54 |
| transformer-fold0 | 20/20 | 0.848 | 0.719 | 0.563–0.865 | 12.59 | 1808 |

Las variantes `-common` usan la suma de CPU de la fuente y del decoder, conservadas por separado en la matriz. No se ha cronometrado un pipeline nuevo completo ni su RAM.
Las variantes con separación reutilizada añaden el coste de preparación medido previamente a su inferencia; no es otro pase completo con separación fría.
La RAM se mide en un proceso sin el evaluador, sobre el mismo fragmento de 30 s; no es una garantía de máximo para canciones de cualquier duración.

| Método | Señales ejecutadas | Positivas evaluadas | F1 del 1 en positivas | Cobertura de agrupación correcta | Cobertura de subdivisión correcta | Unos sin referencia en controles |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| allin1-all | 19/20 | 17/17 | 0.822 | 0.635 | 0.000 | 36 |
| allin1-fold0 | 19/20 | 17/17 | 0.781 | 0.576 | 0.000 | 35 |
| beatnet-1-dbn | 20/20 | 17/17 | 0.300 | 0.235 | 0.000 | 178 |
| beatnet-1-pf | 20/20 | 17/17 | 0.042 | 0.050 | 0.000 | 0 |
| beatnet-2-dbn | 20/20 | 17/17 | 0.255 | 0.411 | 0.000 | 178 |
| beatnet-2-pf | 20/20 | 17/17 | 0.110 | 0.172 | 0.000 | 71 |
| beatnetplus-generic-dbn | 20/20 | 17/17 | 0.328 | 0.516 | 0.000 | 92 |
| beatnetplus-generic-pf | 20/20 | 17/17 | 0.392 | 0.557 | 0.000 | 38 |
| beatnetplus-main-dbn | 20/20 | 17/17 | 0.614 | 0.459 | 0.000 | 178 |
| beatnetplus-nonpercussive-dbn | 20/20 | 17/17 | 0.671 | 0.459 | 0.000 | 178 |
| beatthis-final0-dbn | 20/20 | 17/17 | 0.707 | 0.459 | 0.000 | 47 |
| beatthis-final0-direct | 20/20 | 17/17 | 0.749 | 0.614 | 0.000 | 141 |
| beatthis-final0-direct-common | 20/20 | 17/17 | 0.726 | 0.517 | 0.000 | 71 |
| beatthis-small0-dbn | 20/20 | 17/17 | 0.801 | 0.635 | 0.000 | 74 |
| beatthis-small0-direct | 20/20 | 17/17 | 0.754 | 0.591 | 0.000 | 143 |
| beatthis-small0-direct-common | 20/20 | 17/17 | 0.805 | 0.693 | 0.000 | 109 |
| essentia-degara | 20/20 | 0/17 | — | 0.000 | 0.000 | 0 |
| essentia-multifeature | 20/20 | 0/17 | — | 0.000 | 0.000 | 0 |
| joint | 20/20 | 17/17 | 0.717 | 0.195 | 0.047 | 8 |
| joint-dbn | 20/20 | 17/17 | 0.000 | 0.235 | 0.000 | 56 |
| librosa-global | 20/20 | 0/17 | — | 0.000 | 0.000 | 0 |
| librosa-local | 20/20 | 0/17 | — | 0.000 | 0.000 | 0 |
| madmom-modern-default | 20/20 | 17/17 | 0.619 | 0.575 | 0.000 | 55 |
| madmom-modern-extended | 20/20 | 17/17 | 0.399 | 0.059 | 0.000 | 37 |
| madmom-original-default | 20/20 | 17/17 | 0.619 | 0.575 | 0.000 | 55 |
| madmom-original-extended | 20/20 | 17/17 | 0.399 | 0.059 | 0.000 | 37 |
| soundsible-main | 20/20 | 17/17 | 0.705 | 0.459 | 0.000 | 36 |
| soundsible-p12 | 20/20 | 17/17 | 0.990 | 0.981 | 0.986 | 60 |
| transformer-fold0 | 20/20 | 17/17 | 0.307 | 0.459 | 0.000 | 35 |

| Método | Pesos con frontend MiB | Archivos de dependencias MiB |
| --- | ---: | ---: |
| allin1-all | 90.9 | 1292.9 |
| allin1-fold0 | 81.6 | 1292.9 |
| beatnet-1-dbn | 1.5 | 1202.6 |
| beatnet-1-pf | 1.5 | 1202.6 |
| beatnet-2-dbn | 1.5 | 1202.6 |
| beatnet-2-pf | 1.5 | 1202.6 |
| beatnetplus-generic-dbn | 2.9 | 1178.3 |
| beatnetplus-generic-pf | 2.9 | 1178.3 |
| beatnetplus-main-dbn | 2.9 | 1178.3 |
| beatnetplus-nonpercussive-dbn | 2.9 | 1178.3 |
| beatthis-final0-dbn | 77.3 | 882.4 |
| beatthis-final0-direct | 77.3 | 733.9 |
| beatthis-final0-direct-common | 77.3 | 882.4 |
| beatthis-small0-dbn | 8.1 | 882.4 |
| beatthis-small0-direct | 8.1 | 733.9 |
| beatthis-small0-direct-common | 8.1 | 882.4 |
| essentia-degara | 0.0 | 101.4 |
| essentia-multifeature | 0.0 | 101.4 |
| joint | 0.0 | — |
| joint-dbn | 0.0 | 210.1 |
| librosa-global | 0.0 | 404.5 |
| librosa-local | 0.0 | 404.5 |
| madmom-modern-default | 3.1 | 0.0 |
| madmom-modern-extended | 3.1 | 0.0 |
| madmom-original-default | 3.1 | 210.1 |
| madmom-original-extended | 3.1 | 210.1 |
| soundsible-main | 0.0 | — |
| soundsible-p12 | 0.0 | — |
| transformer-fold0 | 224.8 | 2936.7 |

Dependencias: archivos instalados registrados en los entornos medidos, con dependencias importadas explícitas cuando no las declara el paquete; sin intérprete ni cachés. No son el incremento exacto sobre el instalador de Soundsible. Transformer suma los dos entornos necesarios. Algunos pesos ya forman parte de los paquetes, también modelos no usados: las columnas no son conjuntos disjuntos y no deben sumarse como tamaño mínimo de despliegue.

| Método | Carga de proceso/modelo CPU s | CPU caliente p10/mediana/p90 s/min | Diferencia absoluta entre dos pasadas % |
| --- | ---: | --- | ---: |
| allin1-all | 1.89 | 118.05/123.18/153.72 | — |
| allin1-fold0 | 2.02 | 15.29/15.40/15.74 | — |
| beatnet-1-dbn | 0.90 | 0.23/0.23/0.23 | 0.9 |
| beatnet-1-pf | 0.89 | 3.39/4.39/6.73 | 1.1 |
| beatnet-2-dbn | 0.87 | 0.23/0.23/0.24 | 0.7 |
| beatnet-2-pf | 0.87 | 3.14/4.14/6.27 | 1.7 |
| beatnetplus-generic-dbn | 0.89 | 0.25/0.25/0.26 | 0.9 |
| beatnetplus-generic-pf | 0.88 | 3.06/4.11/6.20 | 0.7 |
| beatnetplus-main-dbn | 0.88 | 0.25/0.25/0.26 | 0.8 |
| beatnetplus-nonpercussive-dbn | 0.88 | 0.24/0.25/0.25 | 0.8 |
| beatthis-final0-dbn | 1.34 | 7.16/7.22/7.27 | 0.5 |
| beatthis-final0-direct | 1.34 | 7.20/7.24/7.30 | 0.6 |
| beatthis-final0-direct-common | — | 0.16/0.16/0.17 | 0.1 |
| beatthis-small0-dbn | 1.19 | 4.19/4.23/4.26 | 0.6 |
| beatthis-small0-direct | 1.18 | 4.27/4.33/4.41 | 0.9 |
| beatthis-small0-direct-common | — | 0.16/0.16/0.17 | 0.1 |
| essentia-degara | 0.55 | 0.09/0.09/0.09 | 0.5 |
| essentia-multifeature | 0.56 | 0.44/0.49/0.49 | 0.3 |
| joint | 0.00 | 0.16/0.19/0.21 | 0.4 |
| joint-dbn | 0.00 | 0.70/0.72/0.73 | 0.3 |
| librosa-global | 0.00 | 0.05/0.05/0.05 | 2.0 |
| librosa-local | 0.00 | 0.05/0.05/0.06 | 2.1 |
| madmom-modern-default | 0.26 | 6.26/6.32/6.39 | 1.2 |
| madmom-modern-extended | 0.24 | 5.30/5.37/6.72 | 0.8 |
| madmom-original-default | 0.06 | 4.97/5.01/5.07 | 0.9 |
| madmom-original-extended | 0.07 | 5.41/5.46/5.59 | 0.5 |
| soundsible-main | 0.00 | 0.09/0.09/0.09 | 1.1 |
| soundsible-p12 | 0.00 | 0.12/0.13/0.14 | 1.0 |
| transformer-fold0 | 6.85 | 3.73/3.75/3.79 | — |

La carga no vacía las cachés del sistema operativo. Los percentiles calientes describen diferencias entre grabaciones; la diferencia entre pasadas solo se calcula cuando ambas ejecutan el mismo trabajo de backend, excluyendo los frontends separados cacheados. Son dos repeticiones, no un estudio de variabilidad entre máquinas. En `-common` el tiempo caliente y la variación son del decoder, con el coste de la fuente aparte.
