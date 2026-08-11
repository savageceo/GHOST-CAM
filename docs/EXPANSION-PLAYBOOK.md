# SAVAGE LAB — expansion playbook

Build instructions for every node in the suite: trip wires, door contacts, the
panic button, the siren, presence radar, cameras #2/#3, NFC tap-to-arm, Govee
lights, and BTS mode. Written so each build is: wire it → paste a sketch →
flash → it's on the dashboard and pinging the phone.

**The one idea that makes all of this cheap:** every gadget is just an ESP32
that calls `lab::event(id, kind, label)`. That single POST files a kind-tagged
event in the dashboard feed AND pushes to every subscribed phone **with the
camera's latest frame attached** — and alarm kinds flash the Govee strips red.
Wiring a new sensor into the suite is one `if` statement.

```
sensor → XIAO C3 → lab::event() → cloud → 📱 push (with camera photo)
                                        → 🚨 event feed
                                        → 💡 lights red (panic)
                                        → 🔊 siren pin (local, same node)
```

---

## 0 · Deploy checklist (do once, before the hardware arrives)

```
cd /Volumes/SAVAGE-BUILDS/SAVAGE-LAB/X-SECURITY/GHOST-CAM
npx drizzle-kit migrate        # 0002 events+cadence, 0003 BTS — idempotent
vercel deploy --prod --yes
arduino-cli compile --fqbn 'esp32:esp32:XIAO_ESP32S3:PSRAM=opi' firmware/lab-cam
arduino-cli upload -p /dev/cu.usbmodem* --fqbn 'esp32:esp32:XIAO_ESP32S3:PSRAM=opi' firmware/lab-cam
```

New env (add in Vercel → Settings → Environment Variables, then redeploy):

| Var | Value | Why |
| --- | --- | --- |
| `GOVEE_API_KEY` | from Govee Home app → profile → Settings → **Apply for API Key** (arrives by email) | lights section + red-alert flash |
| `GOVEE_ALERT_KINDS` | `panic` (default) — or `panic,trip,door` | which events flash the strips red |

Everything else was already in the project (confirmed 2026-08-11).

---

## 1 · Cameras #2 (entry) and #3 (bedroom)

Hardware: 2× XIAO ESP32S3 Sense ($13.99). Same firmware as cam #1.

1. Copy `firmware/lab-cam/config.h.example` → `config.h`; set per camera:
   `DEVICE_ID "entrycam"` / `"bedcam"`, `DEVICE_NAME "Entry"` / `"Bedroom"`,
   `HOSTNAME` to match, same `DEVICE_TOKEN`, same WiFi.
2. Flash (same commands as above). Board: XIAO_ESP32S3, PSRAM: OPI PSRAM.
3. Done — each registers itself, gets its own card, timeline, motion + sound
   detection, and shows in the window picker. No server changes.

Aim: entry cam covers the door at a downward angle (not into a window —
backlight kills motion detection); bedroom cam high corner. Print the corner
mounts (section 12). Cam #1 upgrade: pop the OV2640 off the Sense's connector
and click the OV5640 in — autofocus + 5MP stills, zero code changes.

---

## 2 · Laser tripwire (KY-008) — the visible one

Hardware: KY-008 laser TX + laser-receiver module + XIAO C3. Beam across the
entry at **~1.1 m height** (over the Bengal, over the puppy, through a human).

Wiring (one C3 can run both ends if they're on the same wall corner via a
mirror, but two-post is simpler):

```
KY-008 TX:      S → 3V3 (always on), − → GND        (print: TX post)
Receiver:       VCC → 3V3, GND → GND, OUT → GPIO3   (print: RX post)
Siren (opt.):   GPIO4 → MOSFET gate (section 6)
```

Sketch — copy `firmware/lab-node/` to `firmware/trip-entry/`, set the CONFIG
block (`DEVICE_ID "entrytrip"`), and make the loop:

```cpp
#define BEAM_PIN 3
#define COOLDOWN_MS 8000
static uint32_t lastTrip = 0;

void setup() {
  Serial.begin(115200);
  pinMode(BEAM_PIN, INPUT);
  lab::connectWifi(WIFI_SSID, WIFI_PASS);
  lab::registerDevice(DEVICE_ID, DEVICE_NAME, "tripwire", "[\"trip\"]", "v1");
}

void loop() {
  if (!lab::wifiUp()) { lab::connectWifi(WIFI_SSID, WIFI_PASS); return; }
  bool broken = digitalRead(BEAM_PIN) == LOW;   // beam off the sensor
  if (broken && millis() - lastTrip > COOLDOWN_MS) {
    lastTrip = millis();
    lab::event(DEVICE_ID, "trip", "entry beam");   // 📱 + 📸 + feed
  }
  delay(20);
}
```

Check the receiver's idle logic level on serial first — some boards read HIGH
when lit, some LOW; flip the comparison if yours is inverted. Alignment: print
the two posts with a 3 mm bore, mount with Command strips, and tune by eye —
the red dot must sit on the receiver window.

---

## 3 · Invisible tripwire (VL53L1X) — the sneaky one

No visible beam, no alignment: the sensor measures distance down a corridor
(up to ~4 m) and fires when something closer than the baseline crosses it.

Wiring (I2C): `VIN→3V3, GND→GND, SDA→GPIO6, SCL→GPIO7` on the C3.
Library: `arduino-cli lib install "VL53L1X"` (Pololu).

```cpp
#include <Wire.h>
#include <VL53L1X.h>
VL53L1X tof;
static uint16_t baseline = 0;
static uint32_t lastTrip = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(6, 7);
  tof.setTimeout(500);
  tof.init();
  tof.setDistanceMode(VL53L1X::Long);
  tof.startContinuous(50);
  lab::connectWifi(WIFI_SSID, WIFI_PASS);
  lab::registerDevice(DEVICE_ID, DEVICE_NAME, "tripwire", "[\"trip\"]", "v1");
  delay(1500);
  baseline = tof.read();               // empty-corridor distance
}

void loop() {
  uint16_t mm = tof.read();
  bool crossed = mm > 100 && mm < baseline - 400;   // ≥40 cm closer than empty
  if (crossed && millis() - lastTrip > 8000) {
    lastTrip = millis();
    lab::event(DEVICE_ID, "trip", "hallway zone");
  }
  delay(30);
}
```

Mount at 1.1 m firing across the doorway. Pets: the beam is a narrow cone at
fixed height — same over/under logic as the laser.

---

## 4 · Door / window contact (reed + your magnets)

Hardware: MC-38 wired reed pair (or a bare reed switch + one of your own
magnets — identical electrically). Magnet on the door, switch on the frame,
≤15 mm gap when closed.

Wiring: one lead → `GPIO3`, other lead → `GND`. That's it.

```cpp
#define REED_PIN 3
static bool wasOpen = false;

void setup() {
  Serial.begin(115200);
  pinMode(REED_PIN, INPUT_PULLUP);   // closed door = switch closed = LOW
  lab::connectWifi(WIFI_SSID, WIFI_PASS);
  lab::registerDevice(DEVICE_ID, DEVICE_NAME, "door", "[\"door\"]", "v1");
}

void loop() {
  bool open = digitalRead(REED_PIN) == HIGH;
  if (open && !wasOpen) lab::event(DEVICE_ID, "door", "front door");
  wasOpen = open;
  delay(40);
}
```

The door contact is the **primary armed trigger** for the suite — it fires
before the camera even sees them. Battery option: solder a 3.7 V LiPo to the
XIAO's BAT pads (your batteries only if they're 3.7 V LiPo — AA/9V won't work
directly) and it survives an outage.

---

## 5 · Panic button (hers)

Hardware: XIAO C3 + a big arcade-style button + printed case + 3.7 V LiPo on
the BAT pads so it works even if the wall plug is pulled.

Wiring: button between `GPIO3` and `GND`.

```cpp
#define BTN_PIN 3
#define HOLD_MS 600        // hold-to-fire: no pocket/paw false alarms

void setup() {
  Serial.begin(115200);
  pinMode(BTN_PIN, INPUT_PULLUP);
  lab::connectWifi(WIFI_SSID, WIFI_PASS);
  lab::registerDevice(DEVICE_ID, DEVICE_NAME, "panic", "[\"panic\"]", "v1");
}

void loop() {
  if (digitalRead(BTN_PIN) == LOW) {
    uint32_t t0 = millis();
    while (digitalRead(BTN_PIN) == LOW && millis() - t0 < HOLD_MS) delay(10);
    if (millis() - t0 >= HOLD_MS) {
      lab::event(DEVICE_ID, "panic", "panic button");
      delay(15000);        // one alert per real press
    }
  }
  delay(20);
}
```

What one press does, in order: 🆘 **PANIC** push to every phone with the
camera's live photo attached · event in the feed · **both Govee strips slam
full-bright red** (`GOVEE_ALERT_KINDS=panic`). Print a case with a recessed
button so it can live under the desk or by the bed.

---

## 6 · Siren — the alarm you asked for

Hardware: 12 V piezo siren (100–110 dB), IRLZ44N logic-level MOSFET, 12 V PSU,
1× 10 kΩ resistor.

```
12V+ ── siren(+)                 C3 GPIO4 ──┬── MOSFET gate
        siren(−) ── MOSFET drain            10kΩ
12V− ── MOSFET source ── C3 GND (COMMON!)   gate→GND (pull-down)
```

Drive it from whichever node should scream — the tripwire node is the natural
host (beam broken while armed → siren + event in the same breath):

```cpp
#define SIREN_PIN 4
// inside the trip handler:
digitalWrite(SIREN_PIN, HIGH);   // scream
delay(5000);                     // 5s blast (tune; check hotel neighbors)
digitalWrite(SIREN_PIN, LOW);
```

Print the horn bell — a printed exponential horn noticeably focuses a piezo.
The `commands` table in the schema is the groundwork for "trigger siren from
the dashboard" later; local-trigger ships today with zero server work.

---

## 7 · Presence radar (LD2410C mmWave)

Sees breathing-level presence through the dark, no line of sight needed. OUT
pin goes HIGH on presence — treat it exactly like the reed sketch (`kind:
"presence"`, cooldown 30 s+), or stream it as a `presence` telemetry chip
instead of events if it's too chatty. Wiring: `VCC→5V, GND→GND, OUT→GPIO3`.
Place one behind the entry wall and it detects a person standing at the door
before it opens.

---

## 8 · NFC tap-to-arm (zero hardware — your chips + iPhone)

The geofence endpoint already accepts arm commands; NFC tags make it tactile:

1. iPhone **Shortcuts → Automation → ＋ → NFC → Scan** — hold a chip to the
   phone, name it `SAVAGE ARM`.
2. Action: **Get Contents of URL** →
   `https://www.ghostk.ing/api/geofence?key=<GEOFENCE_KEY>&arm=1`,
   Method **POST**. Turn **Ask Before Running** OFF.
3. Second automation, second chip: same URL with `&arm=0` → `SAVAGE DISARM`.
4. Stick ARM by the door (tap on the way out), DISARM inside. Omit `arm=` on
   a third chip for a toggle.

Print small chip carriers so they look intentional on the wall.

---

## 9 · Studio lights (Govee) — control + red alert

1. Add `GOVEE_API_KEY` in Vercel (section 0) and redeploy.
2. The dashboard grows a **Studio lights** section: both strips, on/off,
   brightness slider, and the SAVAGE swatches (red/purple/cyan/orange/pink/
   white) — set the vibe for a shoot from the same screen as the cameras.
3. Security tie-in: a **panic** event turns every strip **full-bright red**
   automatically. Widen it with `GOVEE_ALERT_KINDS=panic,trip,door` if you
   want the room to light up on any breach.
4. Sanity test from a terminal:

```
curl -H "Govee-API-Key: $KEY" https://openapi.api.govee.com/router/api/v1/user/devices
```

If your key only answers on the old API (`developer-api.govee.com/v1/devices`)
it's a legacy key — request a fresh one in the Govee Home app.

---

## 10 · 🎬 BTS mode — shoots as content, known to everyone

What the **🎬 BTS** button does while ON:

- Motion + sound alerts are fully suppressed — models moving and music playing
  are the point, not an intrusion. No pushes, no sirens, no event spam.
- The **timeline keeps rolling** at full UXGA — that IS the b-roll. After the
  shoot: scrub → **⟦ In / Out ⟧** → **💾 Save clip** → permanent, downloadable,
  postable.
- **⏺ Capture** records a full-res 15 s burst on demand (filed 🎬 in Events,
  silent) — grab the moment while it happens instead of hunting for it later.
- The dashboard shows a 🎬 BTS pill; telemetry charts a `bts` chip so it's
  visible from anywhere that the studio is in shoot mode.

House rules (say them, post them, mean them):

- **Everyone on set knows.** BTS capture is disclosed to every model before
  the shoot and covered in the release (socials/BTS clause). The 🎬 pill on
  the wall-mounted dashboard is the visible tell.
- **Kill switches win.** The inline USB kill switches (order list) sit on each
  camera's power — anyone on set can physically kill a camera, no app, no
  discussion. Changing rooms stay hardware-off during shoots.
- Flip BTS off when the set clears — the note under the buttons nags until
  you do, and arming again is one tap (or the NFC chip / leaving the
  geofence does it for you).

Social workflow: BTS ON → shoot → ⏺ Capture the highlight moments → after,
scrub the timeline and 💾 Save the sequences → open a saved frame full-size →
save to Photos → post. Timelapses of a whole set build in one tap (▶).

---

## 11 · Print queue

| Part | Notes |
| --- | --- |
| Camera corner mounts ×3 | 20° down-tilt wedge; snap-fit the XIAO case; Command-strip back |
| Laser TX post + RX post | 3 mm bore at 1.1 m mark; tiny hood on RX against sunlight |
| Panic button case | recessed big button, LiPo pocket, wall + under-desk variants |
| Siren horn bell | exponential horn ~120 mm; louder + directional |
| Reed contact brackets ×4 | frame side + magnet carrier (fits your magnets) |
| NFC chip wall carriers ×3 | ARM / DISARM / TOGGLE labels embossed |
| Router wall bracket | Slate 7, vents clear |
| mmWave wall puck | LD2410C behind-the-wall mount |

---

## 12 · Order recap (verified 2026-08-11)

| Item | Qty | ~Price | For |
| --- | --- | --- | --- |
| XIAO ESP32S3 Sense | 2 | $13.99 ea | cams #2 + #3 |
| OV5640 w/ heatsink | 1 | $11.99 | cam #1 autofocus |
| XIAO ESP32-C3 | 3 | $4.99 ea | trip / door / panic nodes |
| KY-008 TX + receiver kit | 1 | ~$10 | visible tripwire |
| VL53L1X ToF | 2 | ~$12 ea | invisible trip zones |
| LD2410C mmWave | 2 | ~$6 ea | presence |
| MC-38 reed pairs | 5-pk | ~$7 | door/window contacts |
| 12 V siren + IRLZ44N + 12 V PSU | 1 | ~$20 | the alarm |
| Inline USB kill switches | 3 | ~$9 | shoot-mode hardware off |
| 32 GB microSD (FAT32) | 1 | ~$8 | cam #1 `sd:false` fix |
| 3.7 V LiPo (503450, JST) | 2 | ~$9 ea | panic button + door node backup |
| GL.iNet Slate 7 | 1 | $169.99 | the network bubble |

≈ $310 all-in. Trip wires, cameras, alarm — the three things you named — are
the first four rows plus the siren row.
