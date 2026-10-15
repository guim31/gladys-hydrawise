# Hunter Hydrawise

Controle sus **programadores de riego Hunter Hydrawise** (HC, HPC, Pro-HC, X2 con el módulo
Wi-Fi…) desde Gladys, a través de la nube de Hydrawise: vea qué zona está regando y durante
cuánto tiempo, el próximo riego programado de cada zona, el sensor de lluvia y el agua consumida
hoy; riegue una zona unos minutos, detenga todo, suspenda el programa unos días y reanúdelo.

Esta integración no tiene relación con Hunter Industries. Hydrawise es una marca de Hunter
Industries.

> **Desarrollada sin el hardware: sus comentarios son bienvenidos** (Developed without the
> hardware: feedback welcome). Se escribió a partir de la API de Hydrawise tal como la usan la
> biblioteca pydrawise y la integración de Home Assistant, y se probó contra una nube simulada.
> Díganos qué funciona y qué no en [GitHub](https://github.com/guim31/gladys-hydrawise/issues).

## Requisitos

- Gladys Assistant 5.2.0 o posterior.
- Un programador Hydrawise ya configurado en la aplicación Hydrawise y conectado a internet.
- El correo y la contraseña de su cuenta Hydrawise, y/o su clave de API: en
  [hydrawise.com](https://app.hydrawise.com/), **Account details**, **API key**.
- Gladys debe tener acceso a internet (`app.hydrawise.com` y `api.hydrawise.com`, HTTPS).

## Configuración

En Gladys, **Integraciones**, **Hunter Hydrawise**, **Configuración**:

| Campo                                 | Uso                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Correo de la cuenta                   | El correo con el que se conecta a la aplicación Hydrawise.                            |
| Contraseña                            | La contraseña de la aplicación Hydrawise.                                             |
| Clave de API (opcional)               | Con la cuenta: actualización más rápida. Sola: funciona sin la cuenta.                |
| Duración de los interruptores de zona | Cuánto riega una zona al encender su interruptor (de 5 a 60 minutos, 10 por defecto). |
| Suspensión del programa               | Cuántos días suspende el programa apagar «Riego automático» (2 por defecto).          |
| Idioma de los nombres                 | Idioma de los nombres de las funciones y de los textos (francés por defecto).         |

Luego **Probar la conexión**: la integración enumera sus programadores y sus zonas. En la
pestaña **Descubrimiento**, añada cada programador a Gladys.

### Qué conexión elegir

| Conexión              | Actualización de las zonas | Sensor de lluvia, consumo, fechas de suspensión |
| --------------------- | -------------------------- | ----------------------------------------------- |
| Cuenta                | cada 10 minutos            | sí                                              |
| Cuenta + clave de API | cada 2 minutos             | sí                                              |
| Solo clave de API     | cada 2 minutos             | no                                              |

La cuenta con su clave de API es la configuración de Home Assistant, y la que recomendamos.

### Ritmo de actualización y cuotas de Hydrawise

Hydrawise no publica ninguna cuota, pero rechaza las solicitudes demasiado frecuentes en su API
GraphQL (la de la cuenta). La integración sigue por tanto el presupuesto de la biblioteca
pydrawise, con el que funciona Home Assistant: **como máximo 5 solicitudes GraphQL cada 30
minutos**. Con la cuenta sola, una lectura cada 10 minutos, y el agua consumida hoy una vez por
hora. Con la clave de API, las zonas se leen por la antigua API REST cada 2 minutos (o con menos
frecuencia cuando Hydrawise lo pide, su `nextpoll`), y los detalles por GraphQL cada 30 minutos.
Entre dos lecturas, el tiempo restante de un riego se descuenta localmente, sin solicitud. Una
solicitud rechazada (HTTP 429) pausa esa API durante 30 minutos; una contraseña rechazada solo se
vuelve a intentar al cabo de 30 minutos, nunca en bucle.

La integración se actualiza con su propio temporizador: Gladys no necesita consultar los
dispositivos.

## Dispositivos

Un dispositivo por programador, con estas funciones:

| Función                  | Tipo                              | Uso                                                                          |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------------------- |
| En línea                 | Encendido/apagado, solo lectura   | El programador está en contacto con la nube de Hydrawise.                    |
| Riego automático         | Interruptor                       | Apagado: suspende todas las zonas los días configurados. Encendido: reanuda. |
| Sensor de lluvia         | Detección de lluvia, solo lectura | Cuando hay un sensor de lluvia conectado (conexión con la cuenta).           |
| Agua consumida hoy       | Volumen (litros), solo lectura    | Con un caudalímetro (conexión con la cuenta), actualizado cada hora.         |
| _zona_ · riego           | Interruptor                       | Encendido: riega la zona durante el tiempo configurado. Apagado: la detiene. |
| _zona_ · tiempo restante | Duración (minutos)                | Tiempo restante del riego, 0 en reposo.                                      |
| _zona_ · próximo riego   | Texto                             | Fecha del próximo riego, o «Suspendida hasta el…».                           |
| _zona_ · agua hoy        | Volumen (litros), solo lectura    | Con un caudalímetro.                                                         |

Encender el interruptor de una zona siempre riega durante un tiempo limitado: Hydrawise detiene
la zona por sí mismo al final, incluso si Gladys está parado.

## Widget del panel

El widget **Hydrawise** muestra el número de zonas regando, el agua consumida hoy (con un
caudalímetro) y una línea por zona: regando con el tiempo restante, próximo riego, suspendida o
nada previsto. Elija un programador en su configuración, o déjelo vacío para todos.

Sus botones:

- **Regar…**: elija la zona y la duración (de 1 a 240 minutos).
- **Detener todo**: detiene todas las zonas de los programadores mostrados.
- **Suspender…**: suspende el programa de 1 a 30 días.
- **Reanudar**: termina la suspensión inmediatamente.

Una marca de verificación en **Suspender…** o **Reanudar** indica si el programa está
suspendido.

## Disparador de escena

**Hydrawise: riego terminado**: una zona ha dejado de regar por sí sola, al final de su duración
o de su programa (no cuando Gladys la ha detenido). Filtre por programador si lo necesita.
Variables: el nombre de la zona, su número, el nombre del programador y la duración del riego en
minutos.

Para reaccionar al inicio de un riego, use el estado del interruptor de la zona
(«_zona_ · riego» se enciende) en un disparador «estado de un dispositivo».

## Acciones de escena

- **Hydrawise: regar una zona**: la zona por su número o su nombre como en Hydrawise (sin
  importar acentos ni mayúsculas), y una duración en minutos (10 por defecto, 240 como máximo).
  Con varios programadores, elija el programador cuando el número de zona existe en más de uno.
- **Hydrawise: detener el riego**: una zona, o todas las zonas de un programador o de todos.
- **Hydrawise: suspender el riego**: durante unos días (2 por defecto), una zona o todas; luego
  el programa se reanuda solo. Salida: el fin de la suspensión.
- **Hydrawise: reanudar el riego**: termina una suspensión inmediatamente.

## Ejemplos de escenas

- **Lluvia prevista**: cuando la previsión anuncia lluvia para mañana, **Hydrawise: suspender
  el riego** durante 2 días.
- **Notificación al final**: con **Hydrawise: riego terminado**, envíese «Riego de {{zone}}
  terminado tras {{minutes}} min».
- **Alguien en el jardín**: cuando se abre la puerta del jardín, **Hydrawise: detener el
  riego**.
- **Césped nuevo**: todos los días a las 13:00, **Hydrawise: regar una zona** «Césped» durante 5
  minutos.

## Solución de problemas

- **«Hydrawise ha rechazado la conexión»**: compruebe el correo y la contraseña en la aplicación
  Hydrawise, o la clave de API en hydrawise.com. Tras un rechazo, la integración espera 30
  minutos antes de volver a intentarlo; guardar la configuración lo intenta inmediatamente.
- **«Clave de API rechazada: la cuenta sola actualiza las zonas, más despacio»**: la clave es
  incorrecta o ha sido revocada; genere una nueva en hydrawise.com. Con varios programadores, la
  clave puede servir solo a uno de ellos: los demás se actualizan entonces mediante la cuenta.
- **Una zona iniciada aparece regando y luego no pasa nada**: el programador recoge las órdenes
  de la nube en su siguiente contacto. La integración muestra el estado esperado durante 3
  minutos, y luego el estado que informa Hydrawise.
- **La función «En línea» está apagada**: el programador ha perdido su Wi-Fi, o la nube de
  Hydrawise no responde.
- **Más detalles**: ponga la variable `LOG_LEVEL` de la integración en `debug`. Los registros
  nunca contienen la contraseña, la clave de API ni el token de sesión.

## Limitaciones

- Desarrollada sin el hardware ni una cuenta Hydrawise: las solicitudes se verifican contra el
  esquema del servicio, no contra un programador real.
- Todo pasa por la nube de Hydrawise: sin control local, nada funciona sin internet.
- Sin caudal instantáneo: la API informa uno cuyo significado no está documentado.
- El consumo requiere la conexión con la cuenta y un caudalímetro, y se actualiza una vez por
  hora.
- Los programas en sí (horas de inicio, duraciones, días de riego) se quedan en la aplicación
  Hydrawise.
- Solo con la clave de API: sin sensor de lluvia, sin consumo, y una suspensión no tiene fecha
  de fin.
- Una suspensión del programa se aplica a todas las zonas de un programador; suspenda una sola
  zona con la acción de escena.
