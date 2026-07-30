/** Placeholder skeleton rows shown while the task list loads. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="skeleton-row">
          <td>
            <span className="skeleton skeleton--wide" />
            <span className="skeleton skeleton--narrow" />
          </td>
          <td>
            <span className="skeleton skeleton--mid" />
          </td>
          <td>
            <span className="skeleton skeleton--badge" />
          </td>
          <td>
            <span className="skeleton skeleton--narrow" />
          </td>
          <td>
            <span className="skeleton skeleton--icon" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}
