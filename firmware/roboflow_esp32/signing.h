#pragma once
#include <string>
#include <mbedtls/md.h>

namespace roboflow {
inline std::string hexDigest(const unsigned char* bytes) {
  static const char hex[] = "0123456789abcdef";
  std::string out(64, '0');
  for (int i = 0; i < 32; ++i) { out[2*i] = hex[bytes[i] >> 4]; out[2*i+1] = hex[bytes[i] & 15]; }
  return out;
}
inline std::string signRequest(const std::string& secret, const std::string& method,
                              const std::string& path, const std::string& timestamp,
                              uint32_t sequence, const std::string& body) {
  unsigned char hash[32];
  const auto* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info || mbedtls_md(info, reinterpret_cast<const unsigned char*>(body.data()), body.size(), hash)) return "";
  std::string canonical = method + "\n" + path + "\n" + timestamp + "\n" + std::to_string(sequence) + "\n" + hexDigest(hash);
  if (mbedtls_md_hmac(info, reinterpret_cast<const unsigned char*>(secret.data()), secret.size(),
      reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), hash)) return "";
  return hexDigest(hash);
}
}
