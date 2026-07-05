// lillygo-tembed-cc1101 — SAVAGE LAB sub-GHz RF node
//
// Turns a LilyGo T-Embed CC1101 into a lab device that reports the ambient
// sub-GHz RF noise floor (read straight off the CC1101's RSSI register) plus
// wifi + uptime. It appears in the dashboard grid and its RF floor becomes a
// live chart — great for spotting when something starts transmitting near the
// studio.
//
// This uses minimal raw-SPI access so it needs no external library. For full
// scanning / capture / replay, drop in the ELECHOUSE_CC1101 library and keep
// the lab::telemetry() calls to stream whatever you measure.

// ── CONFIG (edit these) ──────────────────────────────────────────────────
#define LAB_API_HOST "room-watch-six.vercel.app"
#define LAB_DEVICE_TOKEN "4bb9daffafe1e7fb031d700242d11a769017e11269c3173d"

#define WIFI_SSID "SAVAGE STUDIO"
#define WIFI_PASS "Make.Money."

#define DEVICE_ID "tembed-rf"
#define DEVICE_NAME "T-Embed RF"
#define DEVICE_TYPE "sub-ghz-rf"
static const char *DEVICE_CAPS = "[\"rf\",\"cc1101\",\"scanner\"]";
#define FIRMWARE_TAG "tembed-cc1101-1"

#define TELEMETRY_EVERY_MS 30000
// ─────────────────────────────────────────────────────────────────────────

#include "lab_node.h"
#include <SPI.h>

// CC1101 pins on the LilyGo T-Embed CC1101, per Xinyuan-LilyGO/T-Embed-CC1101.
// (Shared SPI bus with the display.) Verify for your board revision if the RF
// numbers look wrong.
#define CC_SCK 11
#define CC_MISO 10
#define CC_MOSI 9
#define CC_CS 44
#define CC_GDO0 43

SPIClass ccSpi(FSPI);

static uint32_t lastSend = 0;
static bool announced = false;

static bool ccWaitReady() {
  uint32_t t = millis();
  while (digitalRead(CC_MISO)) {
    if (millis() - t > 10) return false;  // chip didn't pull SO low
  }
  return true;
}

static uint8_t ccStrobe(uint8_t cmd) {
  ccSpi.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CC_CS, LOW);
  ccWaitReady();
  uint8_t s = ccSpi.transfer(cmd);
  digitalWrite(CC_CS, HIGH);
  ccSpi.endTransaction();
  return s;
}

// Status/config register read (burst+read bits 0xC0).
static uint8_t ccReadReg(uint8_t addr) {
  ccSpi.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CC_CS, LOW);
  ccWaitReady();
  ccSpi.transfer(addr | 0xC0);
  uint8_t v = ccSpi.transfer(0x00);
  digitalWrite(CC_CS, HIGH);
  ccSpi.endTransaction();
  return v;
}

static void ccReset() {
  digitalWrite(CC_CS, LOW);
  delayMicroseconds(5);
  digitalWrite(CC_CS, HIGH);
  delayMicroseconds(40);
  ccStrobe(0x30);  // SRES — software reset
  delay(2);
}

// CC1101 RSSI register (0x34) → dBm. Offset ~74 dB for the 868/915 band.
static int ccRssiDbm() {
  uint8_t raw = ccReadReg(0x34);
  int r = (raw >= 128) ? ((int)raw - 256) : raw;
  return (r / 2) - 74;
}

// Version register (0x31) is nonzero (typ. 0x14) when the chip is alive.
static bool ccPresent() {
  uint8_t ver = ccReadReg(0x31);
  return ver != 0x00 && ver != 0xFF;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n[tembed-rf] boot");

  pinMode(CC_CS, OUTPUT);
  digitalWrite(CC_CS, HIGH);
  pinMode(CC_GDO0, INPUT);
  ccSpi.begin(CC_SCK, CC_MISO, CC_MOSI, CC_CS);
  ccReset();
  Serial.printf("[cc1101] %s\n", ccPresent() ? "detected" : "not found (check pins/power)");
  ccStrobe(0x34);  // SRX — enter receive so RSSI is live

  lab::connectWifi(WIFI_SSID, WIFI_PASS);
}

void loop() {
  if (!lab::wifiUp()) {
    lab::connectWifi(WIFI_SSID, WIFI_PASS);
    delay(500);
    return;
  }

  if (!announced) {
    announced = lab::registerDevice(DEVICE_ID, DEVICE_NAME, DEVICE_TYPE,
                                    DEVICE_CAPS, FIRMWARE_TAG);
    if (announced) Serial.println("[tembed-rf] registered");
  }

  if (millis() - lastSend >= TELEMETRY_EVERY_MS || lastSend == 0) {
    lastSend = millis();
    ccStrobe(0x34);  // ensure RX
    delay(3);
    int rf = ccRssiDbm();
    bool present = ccPresent();

    lab::Metrics m;
    m.add("rfDbm", rf)
        .add("rfLink", present)
        .add("rssi", (int)WiFi.RSSI())
        .add("uptimeMin", (int)(millis() / 60000));
    bool ok = lab::telemetry(DEVICE_ID, m);
    Serial.printf("[tembed-rf] rf=%ddBm telemetry %s\n", rf,
                  ok ? "sent" : "failed");
  }

  delay(50);
}
