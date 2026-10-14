/**
 * The run and batch headers name who asked for the run, from the backend's
 * server-resolved requester; older rows without one render nothing.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RequestedByInline } from "../trigger-badge";

describe("RequestedByInline", () => {
  it("names the requester", () => {
    render(<RequestedByInline label="runner@test.com" />);
    expect(screen.getByText("Requested by").parentElement?.textContent).toBe(
      "Requested by runner@test.com",
    );
  });

  it("renders nothing without a requester", () => {
    const { container } = render(<RequestedByInline label={null} />);
    expect(container.textContent).toBe("");
  });
});
