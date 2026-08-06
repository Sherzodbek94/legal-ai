/**
 * The notice shown while an AI draft is still running.
 *
 * The thing it must never become is a loading screen. The document underneath
 * is already complete — it holds the interpolated template from the moment it
 * was created — so this is a note that the text may improve, not a barrier in
 * front of it. And because a draft that never lands used to present as a button
 * that never resolved, the one outcome this component may not have is spinning
 * forever with nothing said.
 */
import { act, render, screen } from '@testing-library/react';
import { GeneratingNotice } from './generating-notice';

const refresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => {
  refresh.mockClear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/** Advances fake timers inside act, so effects flush. */
function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('GeneratingNotice', () => {
  it('says the document below is already usable', () => {
    // The whole point. A drafter who reads this and waits has been misled.
    render(<GeneratingNotice />);

    expect(screen.getByText(/already filled in from the template/i)).toBeInTheDocument();
  });

  it('announces itself to assistive technology without stealing focus', () => {
    render(<GeneratingNotice />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('re-checks on the interval', () => {
    render(<GeneratingNotice intervalMs={1000} />);

    advance(3000);

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('does not re-check before the first interval elapses', () => {
    render(<GeneratingNotice intervalMs={4000} />);

    advance(3999);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops polling once it gives up', () => {
    // The worker bounds itself at three attempts; past that the poll is noise
    // against the API.
    render(<GeneratingNotice intervalMs={1000} giveUpAfterMs={3000} />);

    advance(3000);
    const atGiveUp = refresh.mock.calls.length;
    advance(10_000);

    expect(refresh).toHaveBeenCalledTimes(atGiveUp);
  });

  it('says so rather than spinning forever', () => {
    // The failure this whole change removed was a spinner with no end. It must
    // not come back as a spinner in a different place.
    render(<GeneratingNotice intervalMs={1000} giveUpAfterMs={3000} />);

    advance(3000);

    expect(screen.getByText(/did not arrive/i)).toBeInTheDocument();
    expect(screen.queryByText(/drafting with ai/i)).not.toBeInTheDocument();
  });

  it('still points at the usable document after giving up', () => {
    render(<GeneratingNotice intervalMs={1000} giveUpAfterMs={3000} />);

    advance(3000);

    expect(screen.getByText(/complete and usable/i)).toBeInTheDocument();
  });

  it('stops polling when unmounted', () => {
    // A drafter who navigates away should not leave a timer refreshing a page
    // that is gone.
    const { unmount } = render(<GeneratingNotice intervalMs={1000} />);

    advance(1000);
    unmount();
    advance(5000);

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
