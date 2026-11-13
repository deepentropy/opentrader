/*
 * Leaving Bar Replay to trade through a broker (#156): "Connect to broker…" in the Trade menu and "Trade through
 * broker" at the end of a session.
 */
import { closeReplay, forgetSavedReplay, replayFinished } from "../../data/replay";
import { tradingUi } from "../../data/trading/trading-ui";

/** Bar Replay closes without asking (reference app), then the broker selection opens. Off replay the charts trade
 *  through the broker connected; a finished replay is not offered again, as when the replay is exited. */
export function leaveReplayForBroker() {
  if (replayFinished()) forgetSavedReplay();
  closeReplay();
  tradingUi.setBrokerPicker(true);
}
