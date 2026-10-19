import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var count = 0
    let output = NSTextField(labelWithString: "Count 0")

    @objc func increment(_ sender: Any?) {
        count += 1
        output.stringValue = "Count \(count)"
    }

    @objc func reset(_ sender: Any?) {
        count = 0
        output.stringValue = "Count 0"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 660, height: 500),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "pi-cua Test Fixture"
        let view = window.contentView!
        let button = NSButton(title: "Increment", target: self, action: #selector(increment(_:)))
        button.frame = NSRect(x: 24, y: 440, width: 120, height: 32)
        view.addSubview(button)
        output.frame = NSRect(x: 170, y: 444, width: 300, height: 24)
        view.addSubview(output)
        let input = NSTextField(string: "initial")
        input.frame = NSRect(x: 24, y: 380, width: 400, height: 28)
        input.setAccessibilityLabel("Test input")
        view.addSubview(input)
        let password = NSSecureTextField(string: "fixture-placeholder")
        password.frame = NSRect(x: 24, y: 330, width: 400, height: 28)
        password.setAccessibilityLabel("Test password")
        view.addSubview(password)
        let slider = NSSlider(value: 2, minValue: 0, maxValue: 10, target: nil, action: nil)
        slider.frame = NSRect(x: 24, y: 280, width: 400, height: 28)
        slider.setAccessibilityLabel("Test slider")
        view.addSubview(slider)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 24, width: 600, height: 230))
        scroll.hasVerticalScroller = true
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 580, height: 2000))
        text.string = (1...100).map { "Fixture row \($0)" }.joined(separator: "\n")
        text.isEditable = false
        text.setAccessibilityLabel("Test rows")
        scroll.documentView = text
        view.addSubview(scroll)

        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit DesktopFixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        menu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        let resetItem = NSMenuItem(title: "Reset", action: #selector(reset(_:)), keyEquivalent: "r")
        resetItem.target = self
        fileMenu.addItem(resetItem)
        fileItem.submenu = fileMenu
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        menu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        NSApplication.shared.mainMenu = menu
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture()
app.delegate = fixture
app.run()
