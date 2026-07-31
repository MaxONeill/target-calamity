import type React from 'react';
import { RELATED_PROJECTS } from '../../content/relatedProjects.js';
import './SeeAlso.css';

/**
 * Sibling projects.
 *
 * NOT A PROMOTIONAL BLOCK. It says what each thing is in one line and links to
 * it, in the same register as the rest of the copy. "See also" rather than
 * "Related projects" because it borrows from a reference work instead of a
 * product page, and it makes no claim about how the projects relate.
 *
 * CONTENT LIVES IN `src/content/projects/*.md`, one file per project, globbed
 * at build time — adding a project is adding a file. Incomplete entries are
 * dropped there and the section disappears when none survive, so an unfilled
 * template is invisible rather than broken.
 */
export function SeeAlso(): React.JSX.Element | null {
  if (RELATED_PROJECTS.length === 0) return null;

  return (
    <details className="tc-seealso">
      {/*
        Collapsed by default. It sits over the globe, and a reader who came for
        the Clock should not have to look past a list of other things to see it.
        <details> rather than a custom disclosure so it is keyboard-operable and
        announced correctly without any of that being reimplemented here.
      */}
      <summary className="tc-seealso__summary">See also</summary>
      <ul className="tc-seealso__list">
        {RELATED_PROJECTS.map((project) => (
          <li key={project.url} className="tc-seealso__item">
            <a
              className="tc-seealso__link"
              href={project.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {project.name}
              <span aria-hidden="true"> ↗</span>
            </a>
            {project.paragraphs.map((text, i) => (
              <p key={i} className="tc-seealso__desc">
                {text}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default SeeAlso;
