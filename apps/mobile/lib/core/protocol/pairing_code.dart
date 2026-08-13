class PairingCode {
  static final RegExp _pattern = RegExp(r'^[A-Z0-9]{4}-[A-Z0-9]{4}$');

  static String normalize(String raw) {
    final alnum = raw.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    if (alnum.length <= 4) return alnum;
    final head = alnum.substring(0, 4);
    final tail = alnum.substring(4);
    final joined = '$head-$tail';
    return joined.length > 9 ? joined.substring(0, 9) : joined;
  }

  static bool isValid(String code) => _pattern.hasMatch(code);
}

class HostPort {
  const HostPort({required this.host, required this.port});

  final String host;
  final int port;

  static const int defaultPort = 8833;

  static HostPort? tryParse(String raw) {
    final input = raw.trim();
    if (input.isEmpty) return null;
    final colonCount = ':'.allMatches(input).length;
    if (colonCount > 1) return null;
    if (colonCount == 1) {
      final parts = input.split(':');
      final host = parts[0].trim();
      final port = int.tryParse(parts[1].trim());
      if (host.isEmpty || port == null || port < 1 || port > 65535) return null;
      return HostPort(host: host, port: port);
    }
    return HostPort(host: input, port: defaultPort);
  }

  Uri toWsUri() => Uri.parse('wss://$host:$port/');

  @override
  String toString() => '$host:$port';
}
