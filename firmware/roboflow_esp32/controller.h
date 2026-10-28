#pragma once
// Núcleo sem Arduino/FreeRTOS: usado também pelos testes nativos.
#include <ArduinoJson.h>
#include <algorithm>
#include <array>
#include <deque>
#include <string>
#include <stdint.h>
#include "settings.h"

namespace roboflow {
using std::string;
constexpr size_t MAX_ACTIONS = 64, MAX_EVENTS = 64;
inline string str(JsonVariantConst v) { return v.is<const char*>() ? v.as<const char*>() : ""; }
inline string encode(const JsonDocument& d) { string s; serializeJson(d, s); return s; }
inline bool id(JsonVariantConst v) { return v.is<const char*>() && !str(v).empty() && str(v).size() <= 128; }
inline bool node(const string& s) {
  size_t comma = s.find(',');
  return comma != string::npos && comma > 0 && comma + 1 < s.size() && s.size() <= 24 &&
    s.find_first_not_of("0123456789", 0) == comma &&
    s.find_first_not_of("0123456789", comma + 1) == string::npos;
}
struct Sensors {
  bool line[3] = {};
  float distanceCm = 0;
  bool distanceValid = false;
  uint32_t distanceAt = 0, sampleNumber = 0;
};
struct Event { uint32_t seq; string json; };
struct Receipt { string id, reason; };

class Controller {
 public:
  MotionSettings cfg;
  string device, session, state = "ready", phase = "idle", mission, block;
  uint32_t revision = 0, completed = 0, total = 0;
  int left = 0, right = 0;
  Sensors sensors;
  uint32_t lastOk = 0;
  bool connected = false;

  Controller(string dev, string sid) : device(dev), session(sid) {}

  JsonDocument hello(uint32_t now) const {
    JsonDocument d;
    base(d, "hello", 1, now);
    d["firmwareVersion"] = "esp32-1.0.0";
    d["protocolVersion"] = 1;
    d["state"] = state;
    d["capabilities"]["supportsReverse"] = false;
    d["capabilities"]["maxActions"] = MAX_ACTIONS;
    d["capabilities"]["maxMessageBytes"] = 4096;
    if (!mission.empty()) {
      d["lastMission"]["missionId"] = mission;
      d["lastMission"]["routeRevision"] = revision;
      d["lastMission"]["completedActions"] = completed;
    }
    return d;
  }

  // Prefixo ordenado: nunca enviar um evento novo saltando críticos pendentes.
  string batch(uint32_t now, bool addTelemetry) {
    string out = "{\"events\":[";
    size_t n = 0;
    for (const auto& ev : pending) {
      if (n == 16 || out.size() + ev.json.size() + 3 > 3900) break;
      if (n++) out += ',';
      out += ev.json;
    }
    if (addTelemetry && n == pending.size() && n < 16) {
      JsonDocument d = telemetry(now);
      string t = encode(d);
      if (out.size() + t.size() + 3 <= 3900) { if (n++) out += ','; out += t; }
    }
    out += "]}";
    return n ? out : "";
  }
  size_t pendingCount() const { return pending.size(); }
  void acknowledge(uint32_t seq) {
    while (!pending.empty() && pending.front().seq <= seq) pending.pop_front();
  }
  void synchronized(uint32_t now) { lastOk = now; connected = true; }

  void reconcile(uint32_t now) {
    // O servidor pediu reconciliação. Para antes de declarar o estado físico.
    if (state == "running") pause(now);
    snapshot(now);
  }
  void snapshot(uint32_t now) {
    auto d = event("snapshot", now);
    d["state"] = state;
    ref(d);
    d["completedActions"] = completed;
    if (total && completed < total) d["actionIndex"] = completed;
    else d["actionIndex"] = nullptr;
    if (block.empty()) d["blockId"] = nullptr; else d["blockId"] = block;
    save(d);
  }

  void apply(JsonObjectConst c, uint32_t receivedAt, uint32_t now) {
    if (pending.size() >= MAX_EVENTS - 4) { fail("EVENT_QUEUE_OVERFLOW", now); return; }
    if (!id(c["messageId"])) { fail("MALFORMED_COMMAND", now); return; }
    string cid = str(c["messageId"]);
    // Reentrega nunca repete movimento, nem troca um reject antigo por ack.
    for (const auto& r : receipts) if (r.id == cid) { reply(c, r.reason, now, false); return; }
    string reason;
    if (str(c["sessionId"]) != session || str(c["deviceId"]) != device) reason = "INVALID_SESSION";
    else if (c["v"] != 1 || !id(c["missionId"]) || !c["validForMs"].is<uint32_t>()) reason = "MALFORMED";
    else if (c["validForMs"].as<uint32_t>() == 0 || uint32_t(now - receivedAt) >= c["validForMs"].as<uint32_t>()) reason = "EXPIRED";
    else if (state == "fault") reason = "INVALID_STATE";
    string type = str(c["type"]);
    if (reason.empty() && type == "load_route") {
      auto a = c["actions"].as<JsonArrayConst>();
      auto nodes = c["expectedNodes"].as<JsonArrayConst>();
      string heading = str(c["initialHeading"]);
      if (!mission.empty() && state != "finished") reason = "BUSY";
      else if (a.isNull() || nodes.isNull() || a.size() == 0 || a.size() != nodes.size() ||
               !node(str(c["startNode"])) || heading.size() != 1 || string("NESW").find(heading) == string::npos ||
               !c["routeRevision"].is<uint32_t>() || c["routeRevision"].as<uint32_t>() == 0) reason = "MALFORMED";
      else if (a.size() > MAX_ACTIONS) reason = "QUEUE_TOO_LARGE";
      else {
        for (size_t i = 0; i < a.size(); ++i) {
          string action = str(a[i]);
          if (action != "F" && action != "D" && action != "E") { reason = "UNSUPPORTED_ACTION"; break; }
          if (!node(str(nodes[i]))) { reason = "MALFORMED"; break; }
        }
      }
      if (reason.empty()) {
        mission = str(c["missionId"]); revision = c["routeRevision"];
        total = a.size(); completed = 0; state = "ready"; phase = "idle";
        block.clear(); blockReason.clear(); needsAbort = false; actionActive = false;
        for (size_t i = 0; i < a.size(); ++i) { actions[i] = str(a[i])[0]; expected[i] = str(nodes[i]); }
        left = right = 0;
      }
    } else if (reason.empty()) {
      if (mission.empty() || str(c["missionId"]) != mission) reason = "NO_ROUTE_LOADED";
      else if ((type == "start" || type == "resume") && c["routeRevision"].as<uint32_t>() != revision) reason = "INVALID_STATE";
      else if (type == "start" || type == "resume") {
        if ((type == "start" && state != "ready") ||
            (type == "resume" && state != "blocked" && state != "paused") || completed >= total || needsAbort) reason = "INVALID_STATE";
        else if (type == "resume" && ((!block.empty() && str(c["blockId"]) != block) || !c["blockId"].is<const char*>())) reason = "STALE_BLOCK";
        else if (!veto(now).empty() || !connected || uint32_t(now - lastOk) > cfg.communicationHoldMs ||
                 (!block.empty() && !blockCleared)) reason = "BLOCKED";
        else {
          if (actionActive) { uint32_t wait = now - pausedAt; phaseAt += wait; actionAt += wait; armedAt += wait; }
          state = "running"; block.clear(); blockReason.clear(); holdAtNode = false; stable = 0;
        }
      } else if (type == "stop") {
        pause(now);
      } else if (type == "abort") {
        left = right = 0; state = "ready"; phase = "idle";
        mission.clear(); total = completed = 0; block.clear(); blockReason.clear();
        actionActive = false; needsAbort = false;
      } else reason = "MALFORMED";
    }
    reply(c, reason, now, true);
    // Não inicia os motores dentro de apply: saída física passa por tick/supervisor.
  }

  void tick(const Sensors& sample, uint32_t now) {
    sensors = sample;
    left = right = 0;
    if (state == "fault") return;
    if (pending.size() >= MAX_EVENTS - 4) { fail("EVENT_QUEUE_OVERFLOW", now); return; }
    if (sample.sampleNumber != lastDistanceSample) {
      lastDistanceSample = sample.sampleNumber;
      if (sample.distanceValid && sample.distanceCm >= cfg.clearCm) {
        if (clearCount < cfg.clearReadings) ++clearCount;
        if (clearCount >= cfg.clearReadings) obstacle = false;
      } else { clearCount = 0; }
      if (sample.distanceValid && sample.distanceCm <= cfg.stopCm) obstacle = true;
    }
    if (!cfg.ultrasonicRequired && (!sample.distanceValid || uint32_t(now - sample.distanceAt) > cfg.sensorMaxAgeMs)) {
      obstacle = false; clearCount = 0;
    }
    const string reason = veto(now);
    if (state == "blocked" || (state == "paused" && !block.empty())) {
      if (!reason.empty()) {
        if (blockCleared || reason != blockReason) {
          blockReason = reason; blockCleared = false; emitBlock(now);
        }
      } else if (!blockCleared) {
        blockCleared = true;
        auto d = event("block_cleared", now); ref(d); d["blockId"] = block; save(d);
      }
      return;
    }
    if (state != "running") return;
    if (!reason.empty()) {
      if (phase == "aligning") needsAbort = true; // não reiniciar curva parcial às cegas
      pausedAt = now; state = "blocked"; blockCleared = false;
      block = "block-" + session + "-" + std::to_string(++blockCounter);
      blockReason = reason; emitBlock(now); return;
    }
    if (!connected || uint32_t(now - lastOk) > cfg.communicationHoldMs) holdAtNode = true;
    if (!actionActive) {
      if (holdAtNode) { communicationPause(now); return; }
      actionActive = true; actionAt = phaseAt = now; stable = 0; turnLeftOldLine = false;
      phase = actions[completed] == 'F' ? "leaving_node" : "aligning";
    }
    if (uint32_t(now - actionAt) > cfg.actionTimeoutMs) { fail("ACTION_TIMEOUT", now); return; }
    if (phase == "aligning") {
      uint32_t elapsed = now - phaseAt;
      if (elapsed > cfg.centerBeforeTurnMs + cfg.turnTimeoutMs) { fail("ALIGN_TIMEOUT", now); return; }
      if (elapsed < cfg.centerBeforeTurnMs) { left = right = cfg.straight; return; }
      bool centerOnly = sensors.line[1] && !sensors.line[0] && !sensors.line[2];
      // Deve abandonar a linha antiga antes de aceitar uma nova linha central.
      if (!sensors.line[1]) turnLeftOldLine = true;
      if (turnLeftOldLine && elapsed >= cfg.centerBeforeTurnMs + cfg.turnMinimumMs && centerOnly) ++stable;
      else stable = 0;
      if (stable >= cfg.stableSamples) { phase = "leaving_node"; phaseAt = now; stable = 0; }
      else {
        left = actions[completed] == 'D' ? cfg.turnPwm : -cfg.turnPwm;
        right = -left; return;
      }
    }
    bool crossing = sensors.line[0] && sensors.line[2] && (!cfg.crossingRequiresCenter || sensors.line[1]);
    if (phase == "leaving_node") {
      if (uint32_t(now - phaseAt) > cfg.leaveTimeoutMs) { fail("LEAVE_TIMEOUT", now); return; }
      if (!crossing && anyLine()) ++stable; else stable = 0;
      if (stable >= cfg.stableSamples) { phase = "following_segment"; armedAt = now; stable = 0; }
    } else {
      if (crossing && uint32_t(now - armedAt) >= cfg.minimumSegmentMs) {
        phase = "confirming_node";
        if (++stable >= cfg.stableSamples) {
          auto d = event("action_completed", now); ref(d);
          d["actionIndex"] = completed; d["expectedNode"] = expected[completed]; save(d);
          ++completed; actionActive = false; phase = "idle";
          if (completed == total) {
            state = "finished";
            auto end = event("mission_completed", now); ref(end); end["completedActions"] = completed; save(end);
          } else if (holdAtNode) communicationPause(now);
          return; // parada confirmada neste cruzamento antes da próxima ação
        }
      } else { stable = 0; phase = "following_segment"; }
    }
    followLine();
  }

  void fail(const char* code, uint32_t now) {
    left = right = 0;
    if (state == "fault") return;
    state = "fault";
    auto d = event("fault", now); ref(d);
    d["code"] = code; d["message"] = code; d["severity"] = "critical"; save(d);
  }

 private:
  std::array<char, MAX_ACTIONS> actions{};
  std::array<string, MAX_ACTIONS> expected;
  std::deque<Event> pending;
  std::deque<Receipt> receipts;
  uint32_t sequence = 1, blockCounter = 0, phaseAt = 0, actionAt = 0, armedAt = 0, pausedAt = 0;
  uint32_t lastDistanceSample = 0;
  uint8_t stable = 0, clearCount = 0;
  bool actionActive = false, turnLeftOldLine = false, obstacle = false;
  bool blockCleared = false, holdAtNode = false, needsAbort = false;
  string blockReason;

  void base(JsonDocument& d, const char* type, uint32_t seq, uint32_t now) const {
    d["v"] = 1; d["type"] = type;
    d["messageId"] = "evt-" + session + "-" + std::to_string(seq);
    d["deviceId"] = device; d["sessionId"] = session;
    d["sequence"] = seq; d["uptimeMs"] = now;
  }
  JsonDocument event(const char* type, uint32_t now) { JsonDocument d; base(d, type, ++sequence, now); return d; }
  void ref(JsonDocument& d) const { if (!mission.empty()) { d["missionId"] = mission; d["routeRevision"] = revision; } }
  void save(const JsonDocument& d) { if (pending.size() < MAX_EVENTS) pending.push_back({d["sequence"].as<uint32_t>(), encode(d)}); }
  void reply(JsonObjectConst c, const string& reason, uint32_t now, bool remember) {
    auto d = event(reason.empty() ? "ack" : "reject", now);
    d["replyTo"] = str(c["messageId"]);
    if (reason.empty()) {
      d["result"] = "accepted"; d["missionId"] = str(c["missionId"]);
      if (c["routeRevision"].is<uint32_t>()) d["routeRevision"] = c["routeRevision"];
    } else d["reason"] = reason;
    save(d);
    if (remember) {
      // Não esquecer IDs durante a sessão: ao atingir o limite, requer reboot.
      if (receipts.size() >= 256) { fail("COMMAND_HISTORY_FULL", now); return; }
      receipts.push_back({str(c["messageId"]), reason});
    }
  }
  bool anyLine() const { return sensors.line[0] || sensors.line[1] || sensors.line[2]; }
  string veto(uint32_t now) const {
    if (cfg.ultrasonicRequired && !sensors.distanceValid) return "sensor_invalid";
    if (cfg.ultrasonicRequired && uint32_t(now - sensors.distanceAt) > cfg.sensorMaxAgeMs) return "sensor_stale";
    if (sensors.distanceValid && uint32_t(now - sensors.distanceAt) <= cfg.sensorMaxAgeMs &&
        (obstacle || sensors.distanceCm <= cfg.stopCm)) return "obstacle";
    if (!anyLine() && phase != "aligning") return "line_lost";
    return "";
  }
  void emitBlock(uint32_t now) {
    auto d = event("block_started", now); ref(d); d["blockId"] = block;
    d["reasons"].to<JsonArray>().add(blockReason); d["actionIndex"] = completed;
    save(d);
  }
  void pause(uint32_t now) {
    if (state == "running") { pausedAt = now; if (phase == "aligning") needsAbort = true; }
    state = "paused"; left = right = 0; stable = 0;
  }
  void communicationPause(uint32_t now) {
    pause(now);
    auto d = event("fault", now); ref(d); d["code"] = "COMM_LOST_HOLD";
    d["message"] = "Parado no cruzamento; retomada exige operador."; d["severity"] = "warning"; save(d);
    snapshot(now);
  }
  void followLine() {
    bool e = sensors.line[0], c = sensors.line[1], d = sensors.line[2];
    if (e && d) left = right = cfg.straight;
    else if (c && !e && !d) left = right = cfg.straight;
    else if (e && c) { left = cfg.inner; right = cfg.outer; }
    else if (d && c) { left = cfg.outer; right = cfg.inner; }
    else if (e) { left = -cfg.correctionReverse; right = cfg.outer; }
    else if (d) { left = cfg.outer; right = -cfg.correctionReverse; }
  }
  JsonDocument telemetry(uint32_t now) {
    auto d = event("telemetry", now); ref(d); d["state"] = state; d["phase"] = phase;
    auto line = d["line"].to<JsonArray>(); for (bool v : sensors.line) line.add(v ? 1 : 0);
    bool valid = sensors.distanceValid && uint32_t(now - sensors.distanceAt) <= cfg.sensorMaxAgeMs;
    d["distanceValid"] = valid;
    if (valid) d["distanceCm"] = sensors.distanceCm; else d["distanceCm"] = nullptr;
    if (sensors.sampleNumber) d["distanceAgeMs"] = uint32_t(now - sensors.distanceAt); else d["distanceAgeMs"] = nullptr;
    if (total && completed < total) d["actionIndex"] = completed; else d["actionIndex"] = nullptr;
    if (!block.empty()) { d["blockId"] = block; d["blockReasons"].to<JsonArray>().add(blockReason); }
    else { d["blockId"] = nullptr; d["blockReasons"].to<JsonArray>(); }
    return d;
  }
};
} // namespace roboflow
