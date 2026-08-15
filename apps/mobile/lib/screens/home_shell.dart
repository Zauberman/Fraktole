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

  static const List<String> _tabs = ['Sessions', 'Orchestrator', 'Settings'];

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
      bottomNavigationBar: ListenableBuilder(
        listenable: widget.controller,
        builder: (context, _) => _TypographyNavBar(
          tabs: _tabs,
          selected: _tab,
          unreadCount: widget.controller.unreadCount,
          onSelect: (index) {
            setState(() => _tab = index);
            widget.controller.setOrchestratorVisible(index == 1);
            // viewing the Orchestrator tab consumes the unread badge
            if (index == 1) widget.controller.clearUnread();
          },
        ),
      ),
    );
  }
}

/// Text-only tab bar: no icons, an underline marks the active tab.
class _TypographyNavBar extends StatelessWidget {
  const _TypographyNavBar({
    required this.tabs,
    required this.selected,
    required this.onSelect,
    this.unreadCount = 0,
  });

  final List<String> tabs;
  final int selected;
  final ValueChanged<int> onSelect;
  final int unreadCount;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainer,
      child: SafeArea(
        top: false,
        child: Container(
          decoration: BoxDecoration(
            border: Border(
              top: BorderSide(color: scheme.outlineVariant),
            ),
          ),
          child: Row(
            children: [
              for (var i = 0; i < tabs.length; i++)
                Expanded(
                  child: InkWell(
                    onTap: () => onSelect(i),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            i == 1 && unreadCount > 0
                                ? '${tabs[i]} $unreadCount'
                                : tabs[i],
                            style: TextStyle(
                              fontSize: 14,
                              letterSpacing: 0.2,
                              fontWeight: selected == i
                                  ? FontWeight.w700
                                  : FontWeight.w400,
                              color: i == 1 && unreadCount > 0
                                  ? scheme.primary
                                  : selected == i
                                      ? scheme.primary
                                      : scheme.onSurfaceVariant,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Container(
                            width: 24,
                            height: 2,
                            decoration: BoxDecoration(
                              color: selected == i
                                  ? scheme.primary
                                  : Colors.transparent,
                              borderRadius: BorderRadius.circular(1),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
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
        final (label, color) = switch (controller.connectionStatus) {
          ConnectionStatus.connected => ('Connected', scheme.primary),
          ConnectionStatus.connecting => (
              'Connecting / reconnecting…',
              scheme.tertiary,
            ),
          ConnectionStatus.disconnected => ('Disconnected', scheme.error),
          ConnectionStatus.authFailed => (
              'Authentication failed',
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
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: color,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          style: Theme.of(context)
                              .textTheme
                              .bodySmall
                              ?.copyWith(
                                color: color,
                                fontWeight: FontWeight.w600,
                              ),
                        ),
                        if (controller.lastError != null)
                          Text(
                            controller.lastError!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context)
                                .textTheme
                                .labelSmall
                                ?.copyWith(
                                    color: color.withValues(alpha: 0.8)),
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
