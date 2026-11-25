// Requires "ESP32 by Espressif Systems" under boards manager
// or "Arduino ESP32 Boards"

// Include required libraries for WiFi, secure connections, MQTT, and JSON
// parsing
#include "secrets.h"
#include "WiFi.h"
//#include "secrets_template.h"
#include <ArduinoJson.h>  // Library > ArduinoJson Benoit Blanchon
#include <MQTTClient.h>   // Library > MQTT by Joel Gaehwiler
#include <WiFiClientSecure.h>
#include <DHT.h>

const int BUTTON_PIN = D2;
const unsigned long DEBOUNCE_MS = 40;

#define DHT_TYPE DHT11
DHT dht1(D3, DHT_TYPE);

// The MQTT topics that this device should publish/subscribe
#define AWS_IOT_PUBLISH_TOPIC "/telemetry"  // Topic for publishing sensor data
#define AWS_IOT_SUBSCRIBE_TOPIC "/downlink"  // Topic for receiving commands from AWS

long sendInterval = 60000;  // Default interval (in milliseconds) at which to
                            // send telemetry to AWS
bool reportSendInterval = false;

bool shadowRequestTemp = false;
bool resetShadowRequestTemp = false;


char
  THINGNAME[13];  // 12 hex digits from the MAC address, plus a null terminator

void setThingName() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(THINGNAME, sizeof(THINGNAME), "%02X%02X%02X%02X%02X%02X", mac[0],
           mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// Initialize secure WiFi client and MQTT client with 1024 byte buffer for
// messages
WiFiClientSecure net = WiFiClientSecure();
MQTTClient client = MQTTClient(1024);

// Establishes connection to AWS IoT Core via WiFi and MQTT
void connectAWS() {
  // Set WiFi to station mode (client mode, not access point)
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  setThingName();

  Serial.println();
  Serial.print("MAC Address: ");
  Serial.println(THINGNAME);

  Serial.println("Connecting to Wi-Fi");

  // Wait until WiFi connection is established
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print("-");
  }
  Serial.println();

  // Configure WiFiClientSecure to use the AWS IoT device credentials for mutual
  // TLS authentication
  net.setCACert(AWS_CERT_CA);           // Root CA certificate
  net.setCertificate(AWS_CERT_CRT);     // Device certificate
  net.setPrivateKey(AWS_CERT_PRIVATE);  // Device private key

  // Connect to the MQTT broker on the AWS endpoint (port 8883 is the standard
  // MQTT over TLS port)
  client.begin(AWS_IOT_ENDPOINT, 8883, net);

  char tlsError[100];
  if (net.connect(AWS_IOT_ENDPOINT, 8883)) {
    Serial.println("TLS verification succeeded");
  } else {
    int code = net.lastError(tlsError, sizeof(tlsError));
    Serial.printf("TLS verification failed (%d): %s\n", code, tlsError);
    time_t now = time(nullptr);
    Serial.print("Device time: ");
    Serial.println(ctime(&now));
    return;
  }

  // Register callback function to handle incoming MQTT messages
  client.onMessage(messageHandler);

  Serial.print("Connecting to AWS IOT");

  // Attempt to connect to AWS IoT using the thing name as client ID
  while (!client.connect(THINGNAME)) {
    Serial.print(".");
    delay(100);
  }
  Serial.println();

  // Verify connection was successful
  if (!client.connected()) {
    Serial.println("AWS IoT Timeout!");
    return;
  }
  Serial.println();
  Serial.println("AWS IoT Connected!");

  // Subscribe to the downlink topic to receive commands from AWS
  char topic[64];
  snprintf(topic, sizeof(topic), "%s%s", THINGNAME, AWS_IOT_SUBSCRIBE_TOPIC);
  if (!client.subscribe(topic)){
    Serial.println("AWS IoT Subscribe failed");
    delay(10000);
    Serial.println("Restarting");
    ESP.restart();
    return;
  }
  Serial.println("AWS IoT Subscribed Succesfully");

}

//setup shadow
void shadowSetup(){
  const String shadow = String("$aws/things/") + THINGNAME + "/shadow"; //koppla in shadow

  if (!client.subscribe(shadow + "/get/accepted") ||
    !client.subscribe(shadow + "/get/rejected") ||
    !client.subscribe(shadow + "/update/delta")) {
  Serial.println("failed to subscribe to shadow");
  delay(10000);
  ESP.restart();
  return;
  }
  Serial.println("Successfully subscribed to shadow");

  //Publish empty payload
  if (!client.publish(shadow + "/get", "")) {
    Serial.println("Kunde inte skicka Shadow GET");
  }
}



// Publishes telemetry data to AWS IoT Core
// Returns true if publish was successful, false otherwise
bool publishTelemetry(String payload) {
  Serial.print("Publishing: ");
  Serial.println(payload);
  char topic[64];
  snprintf(topic, sizeof(topic), "%s%s", THINGNAME, AWS_IOT_PUBLISH_TOPIC);
  return client.publish(topic, payload);
}

//Update variables from shadow
void updateSettings(JsonVariantConst settings) {
  JsonVariantConst interval = settings["sendInterval"];

  if (!interval.is<long>()) {
    return;
  }

  const long newInterval = interval.as<long>();
  if (newInterval <= 0) {
    return;
  }

  sendInterval = newInterval;
  Serial.print("Nytt sendInterval i ms: ");
  Serial.println(sendInterval);
  sendInterval = interval.as<long>();
  reportSendInterval = true;
}

// Callback function that handles incoming MQTT messages
void messageHandler(String &topic, String &payload) {
  Serial.println("incoming: " + topic + " - " + payload);

  JsonDocument doc;

  if (deserializeJson(doc, payload)) {
    Serial.println("Could not read shadow JSON");
    return;
  }

  if (topic.endsWith("/shadow/get/accepted")) {
    JsonVariantConst desired = doc["state"]["desired"];

    updateSettings(desired);
    reportSendInterval = true;

    if (desired["shadowRequestTemp"].is<bool>()) {
      shadowRequestTemp = desired["shadowRequestTemp"].as<bool>();
    }
  }
  else if (topic.endsWith("/shadow/update/delta")) {
    JsonVariantConst changed = doc["state"];

    updateSettings(changed);

    if (changed["shadowRequestTemp"].is<bool>()) {
      shadowRequestTemp = changed["shadowRequestTemp"].as<bool>();
    }
  }
  else if (topic.endsWith("/shadow/get/rejected") && doc["code"] == 404) {
    reportSendInterval = true;
  }
}

bool sendTelemetry() {
  JsonDocument doc;

  float temp = dht1.readTemperature();
  doc["temperature"] = temp;

  String payload;
  serializeJson(doc, payload);
  return publishTelemetry(payload);
}

// Arduino setup function - runs once at startup
void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  delay(5000);
  Serial.begin(115200);  // Initialize serial communication for debugging
  delay(5000);           // Wait for serial monitor to connect
  connectAWS();          // Establish connection to AWS IoT Core
  shadowSetup();
  dht1.begin();
}

// Arduino main loop - runs continuously
void loop() {
  client.loop();

  // Report the active interval and reset a completed temperature request.
  if ((reportSendInterval || resetShadowRequestTemp) && client.connected()) {
    const String topic =
      String("$aws/things/") + THINGNAME + "/shadow/update";

    JsonDocument doc;

    if (reportSendInterval) {
      doc["state"]["reported"]["sendInterval"] = sendInterval;
    }

    if (resetShadowRequestTemp) {
      doc["state"]["desired"]["shadowRequestTemp"] = false;
      doc["state"]["reported"]["shadowRequestTemp"] = false;
    }

    String payload;
    serializeJson(doc, payload);

    if (client.publish(topic, payload)) {
      reportSendInterval = false;
      resetShadowRequestTemp = false;
    }
  }

  static unsigned long previousMillis = millis() - sendInterval;
  static int lastReading = HIGH;
  static int stableState = HIGH;
  static unsigned long lastChange = 0;

  const unsigned long now = millis();
  bool buttonPressed = false;

  const int reading = digitalRead(BUTTON_PIN);

  if (reading != lastReading) {
    lastChange = now;
    lastReading = reading;
  }

  // One physical press produces one reading.
  if (now - lastChange >= DEBOUNCE_MS && reading != stableState) {
    stableState = reading;

    if (stableState == LOW) {
      buttonPressed = true;
    }
  }

  const bool timerDue =
    now - previousMillis >= static_cast<unsigned long>(sendInterval);

  if (timerDue) {
    previousMillis = now;
  }

  // Don't repeat a web request while its reset is waiting to be published.
  const bool webRequest = shadowRequestTemp && !resetShadowRequestTemp;

  // If triggers coincide, publish one reading.
  if (timerDue || buttonPressed || webRequest) {
    if (!sendTelemetry()) {
      Serial.println("Failed to send telemetry. Restarting ESP32.");
      delay(10000);
      ESP.restart();
      return;
    }

    if (webRequest) {
      shadowRequestTemp = false;
      resetShadowRequestTemp = true;
    }
  }
}
