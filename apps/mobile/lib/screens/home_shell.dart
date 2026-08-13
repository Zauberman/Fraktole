import 'package:flutter/material.dart';

import '../core/transport/remote_gateway.dart';
import '../state/app_controller.dart';
import 'orchestrator_screen.dart';
import 'sessions_screen.dart';
import 'settings_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.controller});

  final AppController controller;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final screens = [
      SessionsScreen(controller: widget.controller),
      OrchestratorScreen(controller: widget.controller),
      SettingsScreen(controller: widget.controller),
    ];
    return Scaffold(
      body: Column(
        children: [
          _ConnectionBanner(controller: widget.controller),
          Expanded(child: IndexedStack(index: _tab, children: screens)),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (index) => setState(() => _tab = index),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.view_agenda_outlined),
            selectedIcon: Icon(Icons.view_agenda),
            label: 'Sessions',
          ),
          NavigationDestination(
            icon: Icon(Icons.smart_toy_outlined),
            selectedIcon: Icon(Icons.smart_toy),
            label: 'Orchestrator',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
      ),
    );
  }
}

class _ConnectionBanner extends StatelessWidget {
  const _ConnectionBanner({required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final (label, icon, color) = switch (controller.connectionStatus) {
          ConnectionStatus.connected => (
              'Connected',
              Icons.cloud_done_rounded,
              scheme.primary,
            ),
          ConnectionStatus.connecting => (
              'Connecting / reconnecting…',
              Icons.sync_rounded,
              scheme.tertiary,
            ),
          ConnectionStatus.disconnected => (
              'Disconnected',
              Icons.cloud_off_rounded,
              scheme.error,
            ),
          ConnectionStatus.authFailed => (
              'Authentication failed',
              Icons.lock_rounded,
              scheme.error,
            ),
        };
        return Material(
          color: color.withValues(alpha: 0.12),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                children: [
                  Icon(icon, size: 18, color: color),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          style: Theme.of(context)
                              .textTheme
                              .bodySmall
                              ?.copyWith(color: color),
                        ),
                        if (controller.lastError != null)
                          Text(
                            controller.lastError!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context)
                                .textTheme
                                .labelSmall
                                ?.copyWith(color: color.withValues(alpha: 0.8)),
                          ),
                      ],
                    ),
                  ),
                  if (controller.connectionStatus != ConnectionStatus.connected)
                    TextButton(
                      onPressed: controller.reconnect,
                      child: const Text('Retry'),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
