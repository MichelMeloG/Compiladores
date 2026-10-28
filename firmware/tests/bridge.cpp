// Executa o MESMO controller.h do ESP em processo local, com sensores injetados.
#include "../roboflow_esp32/controller.h"
#include <iostream>

int main() {
  roboflow::Controller rover("RB-01", "boot-native-1");
  uint32_t sampleNo = 0;
  std::string line;
  while (std::getline(std::cin, line)) {
    JsonDocument in, out;
    if (deserializeJson(in, line)) return 2;
    uint32_t now = in["now"] | 1000U;
    std::string op = roboflow::str(in["op"]);
    if (op == "command") rover.apply(in["command"].as<JsonObjectConst>(), in["receivedAt"] | now, now);
    if (op == "tick") {
      roboflow::Sensors s;
      for (int i = 0; i < 3; ++i) s.line[i] = in["line"][i].as<int>() == 1;
      s.distanceValid = in["distanceCm"].is<float>();
      s.distanceCm = in["distanceCm"] | 0.0f;
      s.distanceAt = now - (in["ageMs"] | 0U);
      s.sampleNumber = ++sampleNo;
      rover.tick(s, now);
    }
    if (op == "sync") { rover.acknowledge(in["ackedSequence"] | 0U); rover.synchronized(now); }
    if (op == "resync") rover.reconcile(now);
    if (op == "hello") out["hello"] = rover.hello(now);
    if (op == "batch") {
      std::string batch = rover.batch(now, in["telemetry"] | false);
      JsonDocument d;
      if (!batch.empty()) { deserializeJson(d, batch); out["events"] = d["events"]; }
      else out["events"].to<JsonArray>();
      out["bytes"] = batch.size();
    }
    out["state"] = rover.state; out["phase"] = rover.phase;
    out["completed"] = rover.completed; out["left"] = rover.left; out["right"] = rover.right;
    out["blockId"] = rover.block; out["pending"] = rover.pendingCount();
    std::cout << roboflow::encode(out) << std::endl;
  }
}
