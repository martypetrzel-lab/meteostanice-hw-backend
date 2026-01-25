https://martypetrzel-lab.github.io/meteostanice-publictest/


# 🌦️ Meteostanice – HW backend (EIRA)

Tento repozitář obsahuje **backend pro fyzickou (hardwarovou) testovací verzi chytré meteostanice EIRA**.  
Nejde o simulátor – data pochází **z reálného ESP32 zařízení** se skutečnými senzory.

Projekt představuje **přechodovou fázi mezi simulátorem a finálním fyzickým zařízením**.

---

## 🎯 Účel projektu

- sběr **reálných dat** z ESP32 (teplota, vlhkost, světlo, ventilátor)
- jednotné `/state` API **kompatibilní s Meteostanice UI (v3.36.0)**
- testování chování EIRA v reálných podmínkách
- možnost běhu **bez měření proudu (INA219)** pomocí **virtuální energetiky**

> Tento backend **nahrazuje simulátor** a umožňuje UI pracovat s daty z reálného hardware.

---

## 🧠 Co je EIRA

**EIRA** je dlouhodobý vývojový projekt autonomní, energeticky uvědomělé meteostanice, která:

- sbírá data ze svého okolí
- řídí své chování podle dostupné energie
- učí se z minulých dní (historie, trendy)
- do budoucna bude fungovat **zcela autonomně bez zásahu člověka**

Tato část projektu řeší **HW ingest, stav světa a energetický model**.

---

## 🖥️ Frontend (UI)

Tento backend je určen pro použití s oficiálním frontendem projektu:

👉 **Meteostanice UI 3.36.0**  
🔗 https://martypetrzel-lab.github.io/meteostanice-publictest/

V UI se backend nastavuje v záložce **Nastavení → Backend URL**:

https://meteostanice-hw-backend-production.up.railway.app
---

## 🔌 Hardware (aktuální stav)

Použité / podporované komponenty:

- **ESP32 WROOM**
- **BH1750** – senzor intenzity osvětlení (lux)
- **DHT22** – vnitřní teplota a vlhkost (box)
- **DS18B20** – venkovní teplota
- **Ventilátor 5V / ~200 mA** (PWM řízení)
- **Solární panel 5V / 3W**
- **Li-ion 18650 + TP4056**

### ⚠️ Poznámka k měření energie
V aktuální fázi **není osazen INA219**.  
Energetické hodnoty jsou **virtuálně dopočítávány**.

---

## ⚡ Virtuální energetický model (dočasné řešení)

Dokud není připojen proudový senzor:

- **Solární příjem (W)** je odhadován z hodnot **lux (BH1750)**
- **Zátěž (W)** je odhadována z:
  - konstantní spotřeby ESP32
  - PWM hodnoty ventilátoru
- **Wh (energie)** se integrují v čase

Tento přístup umožňuje:
- testovat energetickou logiku EIRA
- zobrazovat grafy v UI
- ladit chování zařízení bez rizika poškození baterie

---

## 🔜 Plánované rozšíření (nejbližší fáze)

V následující fázi vývoje bude doplněno:

- **2× INA219**
  - 1× měření **příjmu energie ze solárního panelu**
  - 1× měření **výdeje energie do zátěže**
- přechod z virtuální energetiky na **reálné měření**
- přesnější výpočet:
  - SOC
  - denní / noční bilance
  - ochranné režimy baterie

Virtuální model bude poté použit pouze jako **fallback / diagnostika**.

---

## 🌐 API

### `GET /state`
Vrací kompletní stav zařízení ve formátu kompatibilním s UI Meteostanice:

- `world.environment` – prostředí
- `device.*` – HW data
- `energy.*` – energetika (virtuální / reálná)
- `memory.today` – dnešní historie
- `events` – události

### `POST /ingest`
ESP32 sem pravidelně posílá naměřená data:

```json
{
  "env": {
    "boxTempC": 25.1,
    "indoorHumPct": 52,
    "outdoorTempC": 23.4,
    "lightLux": 180,
    "isNight": false
  },
  "fan": {
    "duty": 80
  }
}

🚧 Stav projektu

🧪 aktivní fyzické HW testování

⚙️ zapojení na univerzální desce

🖨️ tisk vlastního boxu / krytu

🔄 ladění ventilace a tepelného chování

🔋 příprava na reálné měření energie (INA219)

Tento repozitář není finální produkční řešení, ale vědomě testovací fáze vývoje.


⚠️ Licence a podmínky použití

© 2026 EIRA / Martin Petržel
Všechna práva vyhrazena.

Tento projekt je autorsky chráněn.

zdrojový kód je zveřejněn výhradně pro studijní a testovací účely

není dovoleno:

komerční použití

nasazení do produkce

kopírování, úpravy nebo distribuce

použití jako základ vlastního projektu
bez výslovného písemného souhlasu autora

Jakékoliv jiné použití vyžaduje souhlas autora projektu EIRA.

📌 Poznámka autora

Cílem není „jen meteostanice“, ale zařízení, které:

přemýšlí o své energii

reaguje na budoucí podmínky (noc, zima, špatné počasí)

učí se z vlastních zkušeností

a časem se stane plně autonomní jednotkou
