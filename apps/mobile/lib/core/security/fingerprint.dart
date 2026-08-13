import 'dart:io';

import 'package:crypto/crypto.dart';

String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

String fingerprintOfCertificate(X509Certificate certificate) =>
    sha256Hex(certificate.der);

bool fingerprintMatches(String expected, String actual) =>
    expected.toLowerCase() == actual.toLowerCase();
