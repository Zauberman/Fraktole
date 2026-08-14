import 'package:flutter/material.dart';

import '../state/app_controller.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final stored = controller.stored;
    final authInfo = controller.authInfo;
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Device',
                      style: theme.textTheme.titleMedium
                          ?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 12),
                  _InfoRow(
                    label: 'Desktop',
                    value: stored == null ? '—' : '${stored.host}:${stored.port}',
                  ),
                  _InfoRow(label: 'Device name', value: stored?.deviceName ?? '—'),
                  _InfoRow(label: 'Device ID', value: stored?.deviceId ?? '—'),
                  _InfoRow(label: 'Server', value: authInfo?.serverName ?? '—'),
                  _InfoRow(label: 'Version', value: authInfo?.version ?? '—'),
                  const SizedBox(height: 8),
                  Text('Server certificate fingerprint',
                      style: theme.textTheme.bodySmall),
                  const SizedBox(height: 4),
                  SelectableText(
                    _groupedFingerprint(stored?.fingerprint ?? ''),
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Verify it matches the fingerprint shown on your desktop.',
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            child: Column(
              children: [
                ListTile(
                  title: const Text('Disconnect'),
                  subtitle: const Text('Reconnect later with saved credentials'),
                  onTap: () => controller.disconnect(),
                ),
                const Divider(height: 1),
                ListTile(
                  title: Text('Forget this device',
                      style: TextStyle(color: theme.colorScheme.error)),
                  subtitle: const Text('Erase token and fingerprint, go back to pairing'),
                  onTap: () => controller.forget(),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Center(
            child: Text('Fraktole Remote v1.0',
                style: TextStyle(color: theme.disabledColor, fontSize: 11)),
          ),
        ],
      ),
    );
  }

  String _groupedFingerprint(String fingerprint) {
    if (fingerprint.length != 64) return fingerprint;
    return RegExp(r'.{1,4}')
        .allMatches(fingerprint)
        .map((m) => m.group(0))
        .join(' ');
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 110,
            child: Text(label,
                style: TextStyle(color: Theme.of(context).disabledColor)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(fontFamily: 'monospace')),
          ),
        ],
      ),
    );
  }
}
